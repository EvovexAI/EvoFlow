import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindCodexAuthCard, codexAuthCardHtml } from '../src/lib/codex-auth-panel.js'
import { gatewayJson } from '../src/lib/gateway-json.js'

vi.mock('../src/lib/gateway-json.js', () => ({ gatewayJson: vi.fn() }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.resetAllMocks()
})

describe('ChatGPT plan model picker', () => {
  it('adds the model selected from the signed-in account catalog', async () => {
    gatewayJson.mockResolvedValueOnce({
      success: true,
      models: [
        { slug: 'gpt-first', display_name: 'First model' },
        { slug: 'gpt-second', display_name: 'Second model' },
      ],
    }).mockResolvedValueOnce({ created: true, model_name: 'codex-gpt-second' })
    document.body.innerHTML = codexAuthCardHtml({ logged_in: true })
    bindCodexAuthCard(document.body)

    const picker = document.querySelector('[data-codex-model]')
    await vi.waitFor(() => expect(picker.options.length).toBe(2))
    picker.value = 'gpt-second'
    document.querySelector('[data-codex-action="ensure-model"]').click()

    expect(gatewayJson).toHaveBeenNthCalledWith(1, 'GET', '/api/codex-auth/models')
    expect(gatewayJson).toHaveBeenNthCalledWith(2, 'POST', '/api/codex-auth/ensure-model', {
      model: 'gpt-second',
      set_primary: false,
    })
  })

  it('keeps model addition disabled if the account catalog fails', async () => {
    gatewayJson.mockResolvedValueOnce({ success: false, message: 'No subscription grant' })
    document.body.innerHTML = codexAuthCardHtml({ logged_in: true })
    bindCodexAuthCard(document.body)

    const picker = document.querySelector('[data-codex-model]')
    await vi.waitFor(() => expect(picker.options[0].textContent).toBe('无法加载订阅模型'))
    expect(document.querySelector('[data-codex-action="ensure-model"]').disabled).toBe(true)
  })
})
