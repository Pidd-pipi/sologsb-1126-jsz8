/** 营位与因子评估的本地读写。写库前统一脱掉响应式 Proxy，避免 DataCloneError。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import { nextSerialNo, nowIso, todayIso } from '@/utils/format'

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

  async function addFactor(input: FactorAssessment): Promise<number> {
    const now = nowIso()
    // 新提交的一律进入待审核，复核人采用前不参与名次 / 地图 / 详情评分
    const record = toPlain({
      ...input,
      assessedAt: input.assessedAt || todayIso(),
      status: 'pending',
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

  /** 复核一轮评估：采用后参与名次计算，退回则仅留历史。 */
  async function reviewFactor(
    id: number,
    decision: 'adopted' | 'returned',
    reviewer: string,
    comment: string
  ): Promise<void> {
    const now = nowIso()
    await db.factors.update(
      id,
      toPlain({
        status: decision,
        reviewer: reviewer.trim(),
        reviewComment: comment.trim(),
        reviewedAt: now,
        updatedAt: now
      })
    )
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
   * 取某营位参与评分的因子记录：最近一份「已采用」评估（按复核时间倒序）。
   * 待审核与已退回记录不参与计算；没有已采用记录时返回 null，
   * 评分层会按保守缺省值处理，绝不拿待审核记录顶上。
   */
  function latestFactor(siteId: number | null | undefined): FactorAssessment | null {
    if (siteId == null) return null
    const rows = factors.value
      .filter((f) => f.siteId === siteId && f.status === 'adopted')
      .sort((a, b) => {
        const ka = a.reviewedAt || a.assessedAt
        const kb = b.reviewedAt || b.assessedAt
        if (ka !== kb) return ka < kb ? 1 : -1
        return (b.id ?? 0) - (a.id ?? 0)
      })
    return rows[0] ?? null
  }

  /** 取某营位全部因子评估（含待审核与已退回，复核列表用，按评估日期倒序）。 */
  function factorsOf(siteId: number | null | undefined): FactorAssessment[] {
    if (siteId == null) return []
    return factors.value
      .filter((f) => f.siteId === siteId)
      .sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1))
  }

  /** 某营位待审核的评估数量，详情页提示用。 */
  function pendingCountOf(siteId: number | null | undefined): number {
    if (siteId == null) return 0
    return factors.value.filter((f) => f.siteId === siteId && f.status === 'pending').length
  }

  const camps = computed(() => Array.from(new Set(list.value.map((s) => s.campName))))
  const total = computed(() => list.value.length)

  return {
    list,
    factors,
    loading,
    loaded,
    total,
    camps,
    load,
    nextCode,
    createSite,
    updateSite,
    removeSite,
    addFactor,
    reviewFactor,
    removeFactor,
    byId,
    latestFactor,
    factorsOf,
    pendingCountOf
  }
})
