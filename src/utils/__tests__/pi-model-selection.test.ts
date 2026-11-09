import { describe, expect, it, vi } from 'vitest'
import { injectConfigVariables } from '../installer-template'
import { promptPiModel, validatePiModel } from '../model-selection'

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn(async () => ({ selectedPiModel: 'provider/large-context-1m' })) },
}))

describe('Pi model configuration', () => {
  it.each([
    '',
    'large-context-1m',
    'provider/large-context-1m',
    't2_provider/model.example:version-1',
  ])('accepts a valid model or an empty default: %s', (model) => {
    expect(validatePiModel(model)).toBe(true)
  })

  it.each(['model with spaces', '--no-mcp', '-h', 'model; rm -rf /', 'model$(command)', 'provider/model\nnext'])('rejects shell syntax: %s', (model) => {
    expect(validatePiModel(model)).not.toBe(true)
  })

  it('reads and trims the model from the shared interactive prompt', async () => {
    await expect(promptPiModel('existing/model')).resolves.toBe('provider/large-context-1m')
  })

  it('injects the selected Pi model into routed wrapper calls', () => {
    const rendered = injectConfigVariables(
      'codeagent-wrapper --backend {{BACKEND_PRIMARY}} {{PI_MODEL_FLAG}}- /work\n'
      + 'codeagent-wrapper --backend pi {{PI_MODEL_FLAG}}resume id -\n'
      + 'codeagent-wrapper --backend codex {{PI_MODEL_FLAG}}- /work',
      { routing: { backend: { models: ['pi'], primary: 'pi' }, piModel: 'provider/large-context-1m' } },
    )
    expect(rendered).toBe(
      'codeagent-wrapper --backend pi --pi-model provider/large-context-1m - /work\n'
      + 'codeagent-wrapper --backend pi --pi-model provider/large-context-1m resume id -\n'
      + 'codeagent-wrapper --backend codex - /work',
    )
  })

  it('uses the configured Pi default when the model is empty or Pi is not routed', () => {
    const template = 'codeagent-wrapper --backend {{BACKEND_PRIMARY}} {{PI_MODEL_FLAG}}-\n{{PI_MODEL_FLAG}}'
    expect(injectConfigVariables(template, {
      routing: { backend: { models: ['pi'], primary: 'pi' }, piModel: '' },
    })).toBe('codeagent-wrapper --backend pi -\n')
    expect(injectConfigVariables(template, {
      routing: { backend: { models: ['codex'], primary: 'codex' }, piModel: 'provider/not-routed' },
    })).toBe('codeagent-wrapper --backend codex -\n')
  })
})
