const { test, expect } = require('@playwright/test')

test('příchozí hovor se zobrazí druhému klientovi', async ({ browser }) => {
  const caller = { id: `caller-${Date.now()}`, name: 'Volající', avatar: null }
  const callee = { id: `callee-${Date.now()}`, name: 'Příjemce', avatar: null }

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()

  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()

  await pageA.addInitScript((user) => {
    localStorage.setItem('rodina:user', JSON.stringify(user))
  }, caller)
  await pageB.addInitScript((user) => {
    localStorage.setItem('rodina:user', JSON.stringify(user))
  }, callee)

  await pageA.goto('/')
  await pageB.goto('/')

  await expect(pageA.getByText('Rodina')).toBeVisible()
  await expect(pageB.getByText('Rodina')).toBeVisible()

  // Počkej na navázání realtime spojení na obou stranách.
  await pageA.waitForTimeout(1200)
  await pageB.waitForTimeout(1200)

  const callRes = await fetch('http://localhost:3001/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: caller.id,
      fromName: caller.name,
      to: callee.id,
      kind: 'audio',
      ts: Date.now()
    })
  })

  expect(callRes.ok).toBeTruthy()

  const pendingHasCall = await pageB.evaluate(async ({ calleeId, callerId }) => {
    const endpoint = `http://localhost:3001/api/call/pending?userId=${encodeURIComponent(calleeId)}`
    for (let i = 0; i < 8; i++) {
      try {
        const r = await fetch(endpoint)
        if (r.ok) {
          const j = await r.json()
          const calls = Array.isArray(j.calls) ? j.calls : []
          if (calls.some((c) => c.from === callerId && c.to === calleeId)) return true
        }
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return false
  }, { calleeId: callee.id, callerId: caller.id })

  expect(pendingHasCall).toBeTruthy()

  await pageB.evaluate((payload) => {
    window.postMessage({ type: 'sw:notifyClick', data: payload }, window.location.origin)
  }, {
    type: 'call',
    from: caller.id,
    fromName: caller.name,
    kind: 'audio',
    ts: Date.now()
  })

  await expect(pageB.getByText('Příchozí hovor od Volající')).toBeVisible({ timeout: 15000 })

  await ctxA.close()
  await ctxB.close()
})
