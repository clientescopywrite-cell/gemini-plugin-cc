import { expect, mock, test } from 'claude-code/testing'

test('gemini-wake turns the wake-up prompt off and on', async ($, on) => {
  mock.store(on)

  const off = await $.command.run({ command: 'gemini-wake', args: 'off' })
  expect(off.text).toContain('off')

  const again = await $.command.run({ command: 'gemini-wake', args: 'on' })
  expect(again.text).toContain('on')
})

test('gemini-panel opens the jobs pane', async ($, on) => {
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  const result = await $.command.run({ command: 'gemini-panel', args: '' })
  expect(result.text).toContain('pane')
  expect(opened).toEqual(['gemini-jobs'])
})
