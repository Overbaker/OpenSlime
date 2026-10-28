import type { WorkflowConfig } from '../types'

// ═══════════════════════════════════════════════════════
// Command builder — adding a new command = 1 function call
// ═══════════════════════════════════════════════════════

type CommandCategory = 'development' | 'init' | 'git' | 'spec'

/**
 * Create a WorkflowConfig with sensible defaults.
 * @param cmdOverride — Use when the slash command name differs from the id (e.g. 'init-project' → 'init')
 */
function cmd(
  id: string,
  order: number,
  category: CommandCategory,
  name: string,
  nameEn: string,
  description: string,
  descriptionEn: string,
  cmdOverride?: string,
): WorkflowConfig {
  return {
    id,
    name,
    nameEn,
    category,
    commands: [cmdOverride ?? id],
    defaultSelected: true,
    order,
    description,
    descriptionEn,
  }
}

// ═══════════════════════════════════════════════════════
// Core commands (always installed): the OpenSpec multi-model chain
// Source: templates/commands/
// ═══════════════════════════════════════════════════════

const CORE_CONFIGS: WorkflowConfig[] = [
  // ── OpenSpec multi-model chain (/osm:*) ──────────────
  cmd('init', 30, 'spec', 'OpenSpec 初始化', 'OpenSpec Init', '初始化 OpenSpec 环境 + 验证多模型工具', 'Initialize OpenSpec and check the model CLIs'),
  cmd('research', 31, 'spec', '需求研究', 'Research', '需求 → 约束集（并行探索 + OpenSpec 提案）', 'Requirements into constraint sets and an OpenSpec proposal'),
  cmd('plan', 32, 'spec', '零决策规划', 'Plan', '多模型分析 → 消除歧义 → 零决策可执行计划', 'Proposal into a zero-decision executable plan'),
  cmd('impl', 33, 'spec', '规范驱动实现', 'Implement', 'codex/antigravity 按任务写代码，Claude 监控审查', 'codex/antigravity write each task; Claude supervises and reviews'),
  cmd('review', 34, 'spec', '归档前审查', 'Review', '独立会话审查 → Critical 必须修复 → 允许归档', 'Independent-session review before archiving'),
]

// Public API
// ═══════════════════════════════════════════════════════

export function getWorkflowConfigs(): WorkflowConfig[] {
  return CORE_CONFIGS.sort((a, b) => a.order - b.order)
}

export function getWorkflowById(id: string): WorkflowConfig | undefined {
  return CORE_CONFIGS.find(w => w.id === id)
}

/** V3 core command IDs (always installed) */
export function getCoreCommandIds(): string[] {
  return CORE_CONFIGS.map(w => w.id)
}

/** All command IDs */
export function getAllCommandIds(): string[] {
  return CORE_CONFIGS.map(w => w.id)
}

/**
 * @deprecated Use getCoreCommandIds() or getAllCommandIds() instead.
 */
export const WORKFLOW_PRESETS = {
  full: {
    name: '完整',
    nameEn: 'Full',
    description: `全部命令（${CORE_CONFIGS.length}个）`,
    descriptionEn: `All commands (${CORE_CONFIGS.length})`,
    workflows: CORE_CONFIGS.map(w => w.id),
  },
}

export type WorkflowPreset = keyof typeof WORKFLOW_PRESETS

export function getWorkflowPreset(preset: WorkflowPreset): string[] {
  return [...WORKFLOW_PRESETS[preset].workflows]
}
