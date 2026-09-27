/**
 * 营位与因子评估的本地读写。写库前统一脱掉响应式 Proxy，避免 DataCloneError。
 *
 * 因子评估走审核流：新提交一律「待审核」，名次表 / 地图 / 详情评分只读取
 * 「已采用」的最近一份记录；「已退回」与历史已采用记录只保留在复核历史里。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment, FactorAssessmentInput, FactorStatus } from '@/types/factor'
import { nextSerialNo, nowIso, todayIso } from '@/utils/format'

/** 排序口径：优先评估日期，再按录入时间兜底，避免同日评估顺序抖动。 */
function compareByAssessedAtDesc(a: FactorAssessment, b: FactorAssessment): number {
  if (a.assessedAt !== b.assessedAt) return a.assessedAt < b.assessedAt ? 1 : -1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return (b.id ?? 0) - (a.id ?? 0)
}

/** 采用口径：最近一次「被采用」的记录优先（按复核时间，再按录入时间兜底）。 */
function compareByAdoptedDesc(a: FactorAssessment, b: FactorAssessment): number {
  const ta = a.reviewedAt || a.createdAt
  const tb = b.reviewedAt || b.createdAt
  if (ta !== tb) return ta < tb ? 1 : -1
  return (b.id ?? 0) - (a.id ?? 0)
}

export const useSiteStore = defineStore('site', () => {
  const list = ref<Campsite[]>([])
  const factors = ref<FactorAssessment[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.sites.orderBy('code').toArray()
      factors.value = await db.factors.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个营位编号，如 CS-0007。 */
  function nextCode(): string {
    return nextSerialNo('CS-', list.value.map((s) => s.code))
  }

  async function createSite(input: Campsite): Promise<number> {
    const now = nowIso()
    const record = toPlain({ ...input, createdAt: now, updatedAt: now }) as Campsite
    delete record.id
    const id = await db.sites.add(record)
    await load()
    return id
  }

  async function updateSite(id: number, patch: Partial<Campsite>): Promise<void> {
    await db.sites.update(id, toPlain({ ...patch, updatedAt: nowIso() }))
    await load()
  }

  async function removeSite(id: number): Promise<void> {
    await db.sites.delete(id)
    const own = factors.value.filter((f) => f.siteId === id)
    await db.factors.bulkDelete(
      own.map((f) => f.id).filter((v): v is number => typeof v === 'number')
    )
    const vetoIds = (await db.vetos.where('siteId').equals(id).toArray())
      .map((v) => v.id)
      .filter((v): v is number => typeof v === 'number')
    await db.vetos.bulkDelete(vetoIds)
    await load()
  }

  /**
   * 追加一轮因子评估：无论调用方传什么，状态一律落为「待审核」，
   * 并清空任何残留的复核信息。审核完成前不参与名次计算。
   */
  async function addFactor(input: FactorAssessmentInput): Promise<number> {
    const now = nowIso()
    const record = toPlain({
      ...input,
      assessedAt: input.assessedAt || todayIso(),
      status: 'pending' as FactorStatus,
      reviewer: '',
      reviewComment: '',
      reviewedAt: '',
      createdAt: now,
      updatedAt: now
    }) as FactorAssessment
    delete record.id
    const id = await db.factors.add(record)
    await load()
    return id
  }

  /** 复核人采用 / 退回一轮评估；意见与复核人为必填。 */
  async function reviewFactor(
    id: number,
    decision: Extract<FactorStatus, 'adopted' | 'rejected'>,
    reviewer: string,
    comment: string
  ): Promise<void> {
    const now = nowIso()
    await db.factors.update(id, {
      status: decision,
      reviewer,
      reviewComment: comment,
      reviewedAt: now,
      updatedAt: now
    })
    await load()
  }

  async function removeFactor(id: number): Promise<void> {
    await db.factors.delete(id)
    await load()
  }

  function byId(id: number | null | undefined): Campsite | null {
    if (id == null || Number.isNaN(id)) return null
    return list.value.find((s) => s.id === id) ?? null
  }

  /**
   * 取某营位当前参与算分的因子记录：仅看「已采用」，取最近被采用的一份。
   * 没有已采用记录时返回 null —— 由评分侧按保守缺省值算分，
   * 绝不能拿待审核 / 已退回记录顶替。
   */
  function adoptedFactor(siteId: number | null | undefined): FactorAssessment | null {
    if (siteId == null) return null
    return (
      factors.value
        .filter((f) => f.siteId === siteId && f.status === 'adopted')
        .sort(compareByAdoptedDesc)[0] ?? null
    )
  }

  /** 某营位待审核的评估（按评估日期倒序），供详情页复核与徽标提示。 */
  function pendingFactors(siteId: number | null | undefined): FactorAssessment[] {
    if (siteId == null) return []
    return factors.value
      .filter((f) => f.siteId === siteId && f.status === 'pending')
      .sort(compareByAssessedAtDesc)
  }

  /** 取某营位全部因子评估（复核历史，新的在前；三种状态都保留）。 */
  function factorsOf(siteId: number | null | undefined): FactorAssessment[] {
    if (siteId == null) return []
    return factors.value
      .filter((f) => f.siteId === siteId)
      .sort(compareByAssessedAtDesc)
  }

  const camps = computed(() => Array.from(new Set(list.value.map((s) => s.campName))))
  const total = computed(() => list.value.length)
  /** 全局待审核条数，用于名次表等页面提示复核人还有几轮没处理。 */
  const pendingCount = computed(() => factors.value.filter((f) => f.status === 'pending').length)

  return {
    list,
    factors,
    loading,
    loaded,
    total,
    camps,
    pendingCount,
    load,
    nextCode,
    createSite,
    updateSite,
    removeSite,
    addFactor,
    reviewFactor,
    removeFactor,
    byId,
    adoptedFactor,
    pendingFactors,
    factorsOf
  }
})
