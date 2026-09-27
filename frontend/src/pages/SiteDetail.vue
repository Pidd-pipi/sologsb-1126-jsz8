<script setup lang="ts">
/**
 * `/sites/:id` 营位详情 —— 上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核。
 * 消费四个模型；复用 <MapPanel>、<FactorScoreBar>、<GradeBadge>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import MapPanel from '@/components/common/MapPanel.vue'
import FactorScoreBar from '@/components/common/FactorScoreBar.vue'
import GradeBadge from '@/components/common/GradeBadge.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useRanking } from '@/hooks/useRanking'
import { FACTOR_META, NORMALIZE_LABELS } from '@/types/score'
import { ASPECT_TYPES, SURFACE_TYPES, ACCESS_MODES } from '@/types/campsite'
import type { AspectType, AccessMode, SurfaceType } from '@/types/campsite'
import type { Grade } from '@/utils/score'
import type { RockfallRisk, WindDir, WindForce, FactorAssessment, FactorStatus } from '@/types/factor'
import { FACTOR_STATUS_LABELS, ROCKFALL_RISKS, WIND_DIRS, WIND_FORCES } from '@/types/factor'
import { VETO_TYPES, VETO_HINTS } from '@/types/veto'
import type { VetoType } from '@/types/veto'
import { formatDate, formatDateTime, todayIso } from '@/utils/format'
import { formatLat, formatLng } from '@/utils/geo'

const route = useRoute()
const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()

const siteId = computed(() => Number(route.params.id))
const site = computed(() => siteStore.byId(siteId.value))

const { scoreOf } = useRanking({
  sites: () => siteStore.list,
  factorOf: (id: number) => siteStore.adoptedFactor(id),
  weights: () => profileStore.activeWeights,
  normalize: () => profileStore.activeProfile?.normalize ?? 'minmax',
  thresholds: () => profileStore.activeProfile?.thresholds ?? { gradeA: 78, gradeB: 58 },
  vetoedIds: () => uiStore.vetoedSiteIds
})

const scoreRow = computed(() => scoreOf(siteId.value))

/** 供 MapPanel 与地图标记回调使用（避免在模板里写带类型标注的箭头函数） */
function gradeOfSite(id: number): Grade {
  return scoreOf(id)?.grade ?? 'C'
}

function openSite(id: number): void {
  void router.push(`/sites/${id}`)
}
const grade = computed(() => scoreRow.value?.grade ?? 'C')
const factorHistory = computed(() => siteStore.factorsOf(siteId.value))
const pendingHistory = computed(() => siteStore.pendingFactors(siteId.value))
/** 当前参与算分的那份已采用记录（没有时为 null，评分走保守缺省值）。 */
const adoptedFactorRow = computed(() => siteStore.adoptedFactor(siteId.value))
const currentAdoptedId = computed(() => adoptedFactorRow.value?.id ?? null)
const vetoList = computed(() => uiStore.vetosOf(siteId.value))

/* --------------------------- 多轮因子复核录入 --------------------------- */
const showFactorForm = ref(false)
const factorForm = reactive({
  waterDistance: 60,
  windDir: '东南' as WindDir,
  windForce: 1 as WindForce,
  signalBars: 4,
  sunHours: 5,
  rockfallRisk: '无' as RockfallRisk,
  shade: 35,
  distanceToCar: 40,
  distanceToTrail: 50,
  assessor: '',
  assessedAt: todayIso()
})

function prefillFactor(): void {
  // 预填参考当前已采用的一份；没有已采用记录时保留表单默认值，
  // 避免把待审核 / 已退回的数值当成基线复制进新表单。
  const base = siteStore.adoptedFactor(siteId.value)
  if (base) {
    factorForm.waterDistance = base.waterDistance
    factorForm.windDir = base.windDir
    factorForm.windForce = base.windForce
    factorForm.signalBars = base.signalBars
    factorForm.sunHours = base.sunHours
    factorForm.rockfallRisk = base.rockfallRisk
    factorForm.shade = base.shade
    factorForm.distanceToCar = base.distanceToCar
    factorForm.distanceToTrail = base.distanceToTrail
    factorForm.assessor = base.assessor
  }
  factorForm.assessedAt = todayIso()
}

async function submitFactor(): Promise<void> {
  if (!site.value) return
  try {
    await siteStore.addFactor({
      siteId: siteId.value,
      waterDistance: Number(factorForm.waterDistance),
      windDir: factorForm.windDir,
      windForce: factorForm.windForce,
      signalBars: Number(factorForm.signalBars),
      sunHours: Number(factorForm.sunHours),
      rockfallRisk: factorForm.rockfallRisk,
      shade: Number(factorForm.shade),
      distanceToCar: Number(factorForm.distanceToCar),
      distanceToTrail: Number(factorForm.distanceToTrail),
      assessor: factorForm.assessor.trim() || '未署名',
      assessedAt: factorForm.assessedAt || todayIso(),
      createdAt: '',
      updatedAt: ''
    })
    showFactorForm.value = false
    ElMessage.success('本轮评估已提交，进入待审核；复核采用前名次与详情评分保持不变')
  } catch (err) {
    ElMessage.error(`追加失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/* ------------------------------ 复核审核流 ------------------------------ */
const reviewVisible = ref(false)
const reviewTarget = ref<FactorAssessment | null>(null)
const reviewDecision = ref<Extract<FactorStatus, 'adopted' | 'rejected'>>('adopted')
const reviewForm = reactive({
  reviewer: '',
  comment: ''
})

function openReview(row: FactorAssessment, decision: 'adopted' | 'rejected'): void {
  reviewTarget.value = row
  reviewDecision.value = decision
  // 复核人默认带上一次署名，意见留空强制填写
  reviewForm.reviewer = reviewForm.reviewer || lastReviewer.value
  reviewForm.comment = ''
  reviewVisible.value = true
}

/** 历史中最近一次复核署名，作为下一次审核的默认复核人。 */
const lastReviewer = computed(() => {
  for (const f of factorHistory.value) {
    if (f.reviewer) return f.reviewer
  }
  return ''
})

const reviewTitle = computed(() =>
  reviewDecision.value === 'adopted' ? '采用本轮评估' : '退回本轮评估'
)

async function submitReview(): Promise<void> {
  const target = reviewTarget.value
  const targetId = target?.id
  if (typeof targetId !== 'number') return
  const reviewer = reviewForm.reviewer.trim()
  const comment = reviewForm.comment.trim()
  if (!reviewer) {
    ElMessage.warning('请填写复核人')
    return
  }
  if (!comment) {
    ElMessage.warning(reviewDecision.value === 'adopted' ? '请填写采用意见' : '请填写退回意见')
    return
  }
  try {
    await siteStore.reviewFactor(targetId, reviewDecision.value, reviewer, comment)
    reviewVisible.value = false
    ElMessage.success(
      reviewDecision.value === 'adopted'
        ? '已采用，名次表、地图与详情评分改按本轮记录计算'
        : '已退回，该记录仅保留在复核历史中'
    )
  } catch (err) {
    ElMessage.error(`审核失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function statusTagType(status: FactorStatus): 'warning' | 'success' | 'info' {
  if (status === 'pending') return 'warning'
  if (status === 'adopted') return 'success'
  return 'info'
}

/** 已退回记录整行置灰，提示其仅留历史、不参与任何计算。 */
function factorRowClass({ row }: { row: FactorAssessment }): string {
  return row.status === 'rejected' ? 'rejected-row' : ''
}

async function removeFactor(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  try {
    await ElMessageBox.confirm(
      '确认删除这一轮因子评估？若删除的是当前采用中的记录，名次将回落到上一份已采用记录或缺省值。',
      '提示',
      { type: 'warning' }
    )
    await siteStore.removeFactor(id)
    ElMessage.success('已删除该轮评估')
  } catch {
    /* 用户取消 */
  }
}

/* ------------------------------ 否决记录 ------------------------------ */
const vetoForm = reactive({
  type: '山洪沟' as VetoType,
  description: '',
  judge: '',
  judgedAt: todayIso()
})

async function addVetoHere(): Promise<void> {
  if (!site.value) return
  if (!vetoForm.description.trim()) {
    ElMessage.warning('请填写否决说明')
    return
  }
  await uiStore.addVeto({
    siteId: siteId.value,
    type: vetoForm.type,
    description: vetoForm.description.trim(),
    judge: vetoForm.judge.trim() || '未署名',
    judgedAt: vetoForm.judgedAt || todayIso(),
    createdAt: '',
    updatedAt: ''
  })
  vetoForm.description = ''
  ElMessage.success('已登记否决项，该营位在名次表与地图上标红且禁止评 A')
}

async function removeVeto(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  await uiStore.removeVeto(id)
  ElMessage.success('已解除该否决项')
}

/* ------------------------------ 基本信息编辑 ------------------------------ */
const editing = ref(false)
const editForm = reactive({
  name: '',
  campName: '',
  elevation: 0,
  slope: 0,
  aspect: '东南' as AspectType,
  surface: '草地' as SurfaceType,
  tentCapacity: 1,
  flatness: 80,
  access: '车行' as AccessMode,
  note: ''
})

function startEdit(): void {
  const s = site.value
  if (!s) return
  editForm.name = s.name
  editForm.campName = s.campName
  editForm.elevation = s.elevation
  editForm.slope = s.slope
  editForm.aspect = s.aspect
  editForm.surface = s.surface
  editForm.tentCapacity = s.tentCapacity
  editForm.flatness = s.flatness
  editForm.access = s.access
  editForm.note = s.note
  editing.value = true
}

async function saveEdit(): Promise<void> {
  if (!site.value) return
  await siteStore.updateSite(siteId.value, {
    name: editForm.name.trim() || site.value.name,
    campName: editForm.campName.trim() || site.value.campName,
    elevation: Number(editForm.elevation),
    slope: Number(editForm.slope),
    aspect: editForm.aspect,
    surface: editForm.surface,
    tentCapacity: Number(editForm.tentCapacity),
    flatness: Number(editForm.flatness),
    access: editForm.access,
    note: editForm.note.trim()
  })
  editing.value = false
  ElMessage.success('营位基础信息已更新')
}

/** 因子明细行，附带原始值与权重信息 */
const factorRows = computed(() => {
  const row = scoreRow.value
  if (!row) return []
  return row.rows.map((r) => ({ ...r, higherIsBetter: metaOf(r.key)?.higherIsBetter ?? true }))
})

function metaOf(key: string) {
  return FACTOR_META.find((m) => m.key === key)
}

watch(
  () => route.params.id,
  () => {
    showFactorForm.value = false
    editing.value = false
    prefillFactor()
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="site" class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>{{ site.code }} · {{ site.name }}</h1>
        <p>
          {{ site.campName }} · {{ site.surface }} · 容 {{ site.tentCapacity }} 帐 ·
          {{ site.access }} · 海拔 {{ site.elevation }} m
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="router.push('/map')">地图视图</el-button>
        <el-button type="primary" @click="startEdit">编辑基础信息</el-button>
      </div>
    </div>

    <el-alert
      v-if="vetoList.length"
      type="error"
      show-icon
      :closable="false"
      title="该营位命中风险否决项，综合等级已被压到 C 级（禁止评 A）"
      :description="vetoList.map((v) => `${v.type}：${v.description}`).join(' ｜ ')"
    />

    <el-alert
      v-if="pendingHistory.length"
      type="warning"
      show-icon
      :closable="false"
      class="pending-alert"
      :title="`有 ${pendingHistory.length} 轮评估待审核（最新一轮 ${pendingHistory[0].assessedAt} · ${pendingHistory[0].assessor}）`"
      description="当前名次、地图着色与下方评分仍使用最近一份已采用记录；请在下方复核表填写复核人与意见后采用或退回。"
    />

    <el-alert
      v-if="!adoptedFactorRow"
      type="info"
      show-icon
      :closable="false"
      class="pending-alert"
      title="该营位还没有已采用的评估记录"
      description="综合得分暂按系统缺省值保守计算；待审核记录不会顶替缺省值，复核采用后才以实测数据算分。"
    />

    <MapPanel
      :sites="siteStore.list"
      :selected-id="siteId"
      :grade-of="gradeOfSite"
      height="360px"
      :title="`营位定位 · ${site.code}`"
      @select="openSite"
    />

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">综合得分</div>
        <div class="stat-card__value">{{ scoreRow?.total ?? '—' }}</div>
        <div class="stat-card__extra">方案 {{ profileStore.activeProfile?.name ?? '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">推荐等级</div>
        <div class="stat-card__value">
          <GradeBadge :grade="grade" size="large" :vetoed="vetoList.length > 0" />
        </div>
        <div class="stat-card__extra">名次第 {{ scoreRow?.rank ?? '—' }} 位</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">坐标</div>
        <div class="stat-card__value coord">{{ formatLng(site.lng) }}</div>
        <div class="stat-card__extra">{{ formatLat(site.lat) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">评估记录</div>
        <div class="stat-card__value">{{ factorHistory.length }}</div>
        <div class="stat-card__extra">
          待审核 {{ pendingHistory.length }} · 否决 {{ vetoList.length }} 条
        </div>
      </div>
    </div>

    <section v-if="editing" class="panel">
      <div class="panel__head">
        <h2>编辑基础信息</h2>
      </div>
      <el-form label-width="112px" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="营位名称">
            <el-input id="edit-name" v-model="editForm.name" />
          </el-form-item>
          <el-form-item label="所属营地">
            <el-input id="edit-camp" v-model="editForm.campName" />
          </el-form-item>
          <el-form-item label="海拔（m）">
            <el-input-number
              id="edit-elevation"
              v-model="editForm.elevation"
              :min="0"
              :max="6000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="坡度（°）">
            <el-input-number
              id="edit-slope"
              v-model="editForm.slope"
              :min="0"
              :max="45"
              :step="0.1"
              :precision="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="坡向">
            <el-select id="edit-aspect" v-model="editForm.aspect" style="width: 100%">
              <el-option v-for="a in ASPECT_TYPES" :key="a" :label="a" :value="a" />
            </el-select>
          </el-form-item>
          <el-form-item label="地表类型">
            <el-select id="edit-surface" v-model="editForm.surface" style="width: 100%">
              <el-option v-for="s in SURFACE_TYPES" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="可容帐篷数">
            <el-input-number
              id="edit-capacity"
              v-model="editForm.tentCapacity"
              :min="1"
              :max="60"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="平整度评分">
            <el-input-number
              id="edit-flatness"
              v-model="editForm.flatness"
              :min="0"
              :max="100"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="进出方式">
            <el-radio-group v-model="editForm.access">
              <el-radio v-for="a in ACCESS_MODES" :key="a" :value="a">{{ a }}</el-radio>
            </el-radio-group>
          </el-form-item>
        </div>
        <el-form-item label="备注">
          <el-input v-model="editForm.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="saveEdit">保存</el-button>
          <el-button @click="editing = false">取消</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>因子打分表</h2>
        <span class="weight-note">
          归一方式：{{ profileStore.activeProfile ? NORMALIZE_LABELS[profileStore.activeProfile.normalize] : '—' }}
          · 等级阈值 A ≥ {{ profileStore.activeProfile?.thresholds.gradeA ?? 78 }} / B ≥
          {{ profileStore.activeProfile?.thresholds.gradeB ?? 58 }}
        </span>
      </div>
      <div class="factor-grid">
        <FactorScoreBar
          v-for="row in factorRows"
          :key="row.key"
          :factor-key="row.key"
          :label="row.label"
          :raw="row.raw"
          :normalized="row.normalized"
          :weight="row.weight"
          :weight-ratio="row.weightRatio"
          :higher-is-better="row.higherIsBetter"
          :contribution="row.contribution"
        />
      </div>
      <p class="panel__hint">
        <template v-if="adoptedFactorRow">
          当前名次所用因子来自已采用记录（{{ adoptedFactorRow.assessedAt }}，
          评估人 {{ adoptedFactorRow.assessor }}，复核人 {{ adoptedFactorRow.reviewer }}）。
        </template>
        <template v-else>
          暂无已采用的评估记录，当前按系统缺省值保守算分；待审核记录不会顶替缺省值。
        </template>
      </p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>多轮因子复核</h2>
        <el-button
          size="small"
          type="primary"
          plain
          @click="
            () => {
              prefillFactor()
              showFactorForm = !showFactorForm
            }
          "
        >
          {{ showFactorForm ? '收起录入' : '追加一轮评估' }}
        </el-button>
      </div>
      <p class="panel__hint" style="margin: 0 0 10px">
        新提交的评估先进入「待审核」，不影响名次；采用后旧记录保留但不再参与计算，退回记录仅留历史。
      </p>

      <el-form v-if="showFactorForm" label-width="112px" class="review-form" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="水源距离（m）">
            <el-input-number
              id="review-water"
              v-model="factorForm.waterDistance"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="风向">
            <el-select id="review-windDir" v-model="factorForm.windDir" style="width: 100%">
              <el-option v-for="d in WIND_DIRS" :key="d" :label="d" :value="d" />
            </el-select>
          </el-form-item>
          <el-form-item label="风力等级">
            <el-select id="review-windForce" v-model="factorForm.windForce" style="width: 100%">
              <el-option v-for="f in WIND_FORCES" :key="f" :label="`${f} 级`" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="信号强度（格）">
            <el-input-number
              id="review-signal"
              v-model="factorForm.signalBars"
              :min="0"
              :max="5"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="日照时长（h）">
            <el-input-number
              id="review-sun"
              v-model="factorForm.sunHours"
              :min="0"
              :max="14"
              :step="0.1"
              :precision="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="落石落枝风险">
            <el-select id="review-rockfall" v-model="factorForm.rockfallRisk" style="width: 100%">
              <el-option v-for="r in ROCKFALL_RISKS" :key="r" :label="r" :value="r" />
            </el-select>
          </el-form-item>
          <el-form-item label="植被遮蔽度">
            <el-input-number
              id="review-shade"
              v-model="factorForm.shade"
              :min="0"
              :max="100"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="离车距离（m）">
            <el-input-number
              id="review-car"
              v-model="factorForm.distanceToCar"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="离步道（m）">
            <el-input-number
              id="review-trail"
              v-model="factorForm.distanceToTrail"
              :min="0"
              :max="5000"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="评估人">
            <el-input id="review-assessor" v-model="factorForm.assessor" />
          </el-form-item>
          <el-form-item label="评估日期">
            <el-date-picker
              id="review-date"
              v-model="factorForm.assessedAt"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <el-form-item>
          <el-button type="primary" @click="submitFactor">提交本轮评估</el-button>
        </el-form-item>
      </el-form>

      <el-table v-if="factorHistory.length" :data="factorHistory" size="small" border :row-class-name="factorRowClass">
        <el-table-column label="序号" width="64" type="index" />
        <el-table-column label="评估日期" width="112">
          <template #default="{ row }">{{ formatDate(row.assessedAt) }}</template>
        </el-table-column>
        <el-table-column prop="assessor" label="评估人" width="96" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ FACTOR_STATUS_LABELS[row.status as FactorStatus] }}
            </el-tag>
            <el-tag
              v-if="row.status === 'adopted' && row.id === currentAdoptedId"
              type="success"
              size="small"
              effect="dark"
              class="ml6"
            >
              采用中
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水源" width="84">
          <template #default="{ row }">{{ row.waterDistance }} m</template>
        </el-table-column>
        <el-table-column label="风向 / 风力" width="120">
          <template #default="{ row }">{{ row.windDir }} {{ row.windForce }} 级</template>
        </el-table-column>
        <el-table-column label="信号" width="72">
          <template #default="{ row }">{{ row.signalBars }} 格</template>
        </el-table-column>
        <el-table-column label="日照" width="80">
          <template #default="{ row }">{{ row.sunHours }} h</template>
        </el-table-column>
        <el-table-column label="落石落枝" width="90">
          <template #default="{ row }">{{ row.rockfallRisk }}</template>
        </el-table-column>
        <el-table-column label="遮蔽度" width="80">
          <template #default="{ row }">{{ row.shade }}</template>
        </el-table-column>
        <el-table-column label="离车 / 离步道" width="132">
          <template #default="{ row }">{{ row.distanceToCar }} / {{ row.distanceToTrail }} m</template>
        </el-table-column>
        <el-table-column label="复核信息" min-width="220">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <span class="muted">待复核人处理</span>
            </template>
            <template v-else>
              <div class="review-cell">
                <span class="review-cell__head">
                  {{ row.reviewer || '—' }} · {{ row.reviewedAt ? formatDateTime(row.reviewedAt) : '—' }}
                </span>
                <span class="review-cell__comment">{{ row.reviewComment || '—' }}</span>
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="录入时间" width="146">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'pending'"
              size="small"
              text
              type="success"
              @click="openReview(row, 'adopted')"
            >
              采用
            </el-button>
            <el-button
              v-if="row.status === 'pending'"
              size="small"
              text
              type="warning"
              @click="openReview(row, 'rejected')"
            >
              退回
            </el-button>
            <el-button size="small" text type="danger" @click="removeFactor(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">暂无因子评估记录，点击「追加一轮评估」开始录入。</p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>风险否决记录</h2>
        <span class="weight-note">命中任一条即整行标红并禁止评 A</span>
      </div>

      <el-table v-if="vetoList.length" :data="vetoList" size="small" border>
        <el-table-column prop="type" label="否决类型" width="130">
          <template #default="{ row }">
            <el-tag type="danger" size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="260" />
        <el-table-column prop="judge" label="判定人" width="110" />
        <el-table-column label="判定日期" width="120">
          <template #default="{ row }">{{ formatDate(row.judgedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="danger" @click="removeVeto(row.id)">解除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">该营位暂无否决记录，可在下方直接登记。</p>

      <el-divider content-position="left">登记新的否决项</el-divider>
      <el-form label-width="100px" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="否决类型">
            <el-select id="veto-type" v-model="vetoForm.type" style="width: 100%">
              <el-option v-for="t in VETO_TYPES" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
          <el-form-item label="判定人">
            <el-input id="veto-judge" v-model="vetoForm.judge" placeholder="如 周勘" />
          </el-form-item>
          <el-form-item label="判定日期">
            <el-date-picker
              id="veto-date"
              v-model="vetoForm.judgedAt"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <el-form-item label="说明">
          <el-input
            id="veto-desc"
            v-model="vetoForm.description"
            type="textarea"
            :rows="2"
            :placeholder="VETO_HINTS[vetoForm.type]"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="danger" plain @click="addVetoHere">登记否决项</el-button>
        </el-form-item>
      </el-form>
    </section>

    <el-dialog v-model="reviewVisible" :title="reviewTitle" width="520px">
      <div v-if="reviewTarget" class="review-target">
        <el-tag :type="statusTagType(reviewTarget.status)" size="small">
          {{ FACTOR_STATUS_LABELS[reviewTarget.status] }}
        </el-tag>
        <span class="weight-note">
          {{ formatDate(reviewTarget.assessedAt) }} · 评估人 {{ reviewTarget.assessor }} ·
          水源 {{ reviewTarget.waterDistance }} m · 风力 {{ reviewTarget.windForce }} 级 ·
          信号 {{ reviewTarget.signalBars }} 格
        </span>
      </div>
      <el-alert
        class="review-tip"
        :type="reviewDecision === 'adopted' ? 'success' : 'warning'"
        :closable="false"
        show-icon
        :title="
          reviewDecision === 'adopted'
            ? '采用后：名次表、地图与详情评分改按本轮记录计算，此前已采用的旧记录保留但不再参与计算。'
            : '退回后：本轮记录仅保留在复核历史中，不参与任何计算。'
        "
      />
      <el-form label-width="84px" @submit.prevent>
        <el-form-item label="复核人" required>
          <el-input id="review-reviewer" v-model="reviewForm.reviewer" placeholder="如 周勘" />
        </el-form-item>
        <el-form-item :label="reviewDecision === 'adopted' ? '采用意见' : '退回意见'" required>
          <el-input
            id="review-comment"
            v-model="reviewForm.comment"
            type="textarea"
            :rows="3"
            :placeholder="reviewDecision === 'adopted' ? '如 现场复测数值可信，予以采用。' : '如 水源距离与现场不符，请重新测量后提交。'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button
          :type="reviewDecision === 'adopted' ? 'success' : 'warning'"
          @click="submitReview"
        >
          确认{{ reviewDecision === 'adopted' ? '采用' : '退回' }}
        </el-button>
      </template>
    </el-dialog>
  </div>

  <div v-else class="page">
    <section class="panel">
      <EmptyState
        title="没有找到这个营位"
        description="该营位可能已被删除，或链接中的编号不正确。返回名次表查看全部候选营位，或直接新增一个。"
        action-text="新增营位"
        @action="router.push('/sites/new')"
      />
    </section>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 0 18px;
}
.factor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 8px;
}
.coord {
  font-size: 15px;
}
.review-form {
  margin-bottom: 12px;
}
.pending-alert {
  margin-bottom: 12px;
}
.ml6 {
  margin-left: 6px;
}
.review-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.review-cell__head {
  font-size: 12px;
  color: var(--gb-ink);
}
.review-cell__comment {
  font-size: 12px;
  color: var(--gb-muted);
  line-height: 1.5;
}
.review-target {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.review-tip {
  margin-bottom: 14px;
}
:deep(.rejected-row) {
  color: var(--gb-muted);
  background: #fafafa !important;
}
:deep(.el-table .rejected-row:hover > td) {
  background: #f3f3f3 !important;
}
</style>
