/**
 * FactorAssessment（因子评估）—— 逐项打分所需的现场实测因子。
 * 一轮评估 = 一条记录，多轮评估可在详情页做复核对比。
 * 每轮评估带审核状态：新记录先进入「待审核」，复核人采用后才参与名次计算。
 */

/** 落石落枝风险等级 */
export type RockfallRisk = '无' | '低' | '中' | '高'

/** 评估审核状态：待审核 / 已采用 / 已退回 */
export type ReviewStatus = 'pending' | 'adopted' | 'returned'

/** 风力等级（蒲福风级取整段） */
export type WindForce = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 风向 */
export type WindDir = '北' | '东北' | '东' | '东南' | '南' | '西南' | '西' | '西北'

export interface FactorAssessment {
  /** 主键，自增 */
  id?: number
  /** 所属营位 id */
  siteId: number
  /** 水源距离（米） */
  waterDistance: number
  /** 风向 */
  windDir: WindDir
  /** 风力等级 */
  windForce: WindForce
  /** 通信信号强度（格，0-5） */
  signalBars: number
  /** 日照时长（小时） */
  sunHours: number
  /** 落石落枝风险 */
  rockfallRisk: RockfallRisk
  /** 植被遮蔽度（0-100，越高越阴凉） */
  shade: number
  /** 离车距离（米） */
  distanceToCar: number
  /** 离步道距离（米） */
  distanceToTrail: number
  /** 评估人 */
  assessor: string
  /** 评估日期（YYYY-MM-DD） */
  assessedAt: string
  /** 审核状态：新记录一律 pending，复核采用后才参与名次计算 */
  status: ReviewStatus
  /** 复核人（采用 / 退回时填写） */
  reviewer: string
  /** 复核意见 */
  reviewComment: string
  /** 复核时间（ISO），决定「最近一份已采用」的先后顺序 */
  reviewedAt: string
  createdAt: string
  updatedAt: string
}

export const WIND_DIRS: WindDir[] = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']

export const WIND_FORCES: WindForce[] = [0, 1, 2, 3, 4, 5, 6]

export const ROCKFALL_RISKS: RockfallRisk[] = ['无', '低', '中', '高']

/** 审核状态展示文案 */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: '待审核',
  adopted: '已采用',
  returned: '已退回'
}

/** 落石落枝风险对应的适宜度（越高越安全） */
export const ROCKFALL_SCORE: Record<RockfallRisk, number> = {
  无: 100,
  低: 82,
  中: 48,
  高: 15
}
