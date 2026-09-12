/**
 * 观测面板统一布局组件
 *
 * 用法：
 * - ObsPage          页面根容器
 * - ObsStatStrip     顶部统计条
 * - ObsStatItem      单个统计卡片
 * - ObsSection       内容卡片（图表、列表等）
 * - ObsGroup         分组列表容器
 * - ObsListRow       分组列表行
 * - ObsTablePanel    表格卡片（明细表标准样式）
 * - ObsSegmentTabs   iOS 分段切换
 */
export {
  ObsPage,
  ObsStatItem,
  ObsStatStrip,
  ObsSection,
  ObsGroup,
  ObsListRow,
  ObsTablePanel,
  ObsPagination,
  ObsSegmentTabs,
  ObsBanner,
  ObsEmpty,
} from './ObsLayout'
export type { ObsStatItemProps, ObsSectionProps, ObsTableColumn, ObsListRowMetric, ObsPaginationProps } from './ObsLayout'
