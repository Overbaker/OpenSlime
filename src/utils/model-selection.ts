import inquirer from 'inquirer'

/** Model IDs are interpolated into command templates, so reject shell syntax. */
export function validateOpencodeModel(value: string, isZh = true): true | string {
  const model = value.trim()
  if (!model || /^[\w.-]+\/[\w.:/-]+$/.test(model))
    return true
  return isZh
    ? '请填写 provider/model（不能包含空格或 shell 符号），或留空使用 OpenCode 默认模型'
    : 'Enter provider/model without spaces or shell syntax, or leave empty for the OpenCode default'
}

export async function promptOpencodeModel(currentModel = '', isZh = true): Promise<string> {
  const { selectedOpencodeModel } = await inquirer.prompt([{
    type: 'input',
    name: 'selectedOpencodeModel',
    message: isZh
      ? 'OpenCode 模型 provider/model（留空使用 OpenCode 默认）'
      : 'OpenCode model provider/model (empty uses the OpenCode default)',
    default: currentModel,
    suffix: isZh
      ? '\n  先在 OpenCode 配好 provider；用 opencode models 查看型号，DeepSeek 可用 opencode models deepseek。\n'
      : '\n  Configure your provider in OpenCode first; list IDs with opencode models (DeepSeek: opencode models deepseek).\n',
    validate: (value: string) => validateOpencodeModel(value, isZh),
  }])
  return selectedOpencodeModel.trim()
}

/** Pi accepts provider/model or a globally unique model ID; no argv/shell characters. */
export function validatePiModel(value: string, isZh = true): true | string {
  const model = value.trim()
  if (!model || /^(?!-)[\w.-]+(?:\/[\w.:/-]+)?$/.test(model))
    return true
  return isZh
    ? '请填写 provider/model 或唯一模型 ID（不能包含空格或 shell 符号），或留空使用 Pi 默认模型'
    : 'Enter provider/model or a unique model ID without spaces or shell syntax, or leave empty for the Pi default'
}

export async function promptPiModel(currentModel = '', isZh = true): Promise<string> {
  const { selectedPiModel } = await inquirer.prompt([{
    type: 'input',
    name: 'selectedPiModel',
    message: isZh
      ? 'Pi 模型 provider/model 或唯一模型 ID（留空使用 Pi 默认）'
      : 'Pi model provider/model or unique model ID (empty uses the Pi default)',
    default: currentModel,
    suffix: isZh
      ? '\n  先在 Pi 中配置 provider/模型；用 pi --list-models 查看。支持 1M 上下文需在 Pi/model 自身配置中启用。\n'
      : '\n  Configure providers/models in Pi first; inspect them with pi --list-models. Enable 1M context in Pi/model configuration.\n',
    validate: (value: string) => validatePiModel(value, isZh),
  }])
  return selectedPiModel.trim()
}
