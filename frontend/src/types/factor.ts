/**
 * FactorAssessment（因子评估）—— 逐项打分所需的现场实测因子。
 * 一轮评估 = 一条记录，提交后先进入「待审核」，由复核人采用 / 退回；
 * 名次表、地图与详情评分只消费「已采用」记录，待审核与已退回记录仅留历史。
 */

/** 落石落枝风险等级 */
export type RockfallRisk = '无' | '低' | '中' | '高'

/** 风力等级（蒲福风级取整段） */
export type WindForce = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 风向 */
export type WindDir = '北' | '东北' | '东' | '东南' | '南' | '西南' | '西' | '西北'

/** 审核状态：待审核（新提交）/ 已采用（参与算分）/ 已退回（仅留历史） */
export type FactorStatus = 'pending' | 'adopted' | 'rejected'

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
  /** 审核状态；v4 迁移会把存量记录视为已采用 */
  status: FactorStatus
  /** 复核人（采用 / 退回时填写） */
  reviewer: string
  /** 复核意见 */
  reviewComment: string
  /** 复核时间（ISO 字符串） */
  reviewedAt: string
  createdAt: string
  updatedAt: string
}

/** 录入 / 追加评估时的入参：审核字段由 store 统一补为待审核。 */
export type FactorAssessmentInput = Omit<
  FactorAssessment,
  'status' | 'reviewer' | 'reviewComment' | 'reviewedAt'
>

export const WIND_DIRS: WindDir[] = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']

export const WIND_FORCES: WindForce[] = [0, 1, 2, 3, 4, 5, 6]

export const ROCKFALL_RISKS: RockfallRisk[] = ['无', '低', '中', '高']

export const FACTOR_STATUS_LABELS: Record<FactorStatus, string> = {
  pending: '待审核',
  adopted: '已采用',
  rejected: '已退回'
}

/** 落石落枝风险对应的适宜度（越高越安全） */
export const ROCKFALL_SCORE: Record<RockfallRisk, number> = {
  无: 100,
  低: 82,
  中: 48,
  高: 15
}
