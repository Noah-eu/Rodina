import { act, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('./firebase', () => ({
  db: {},
  storage: {},
  ensureAuth: () => Promise.resolve()
}))

vi.mock('./push', () => ({
  initPush: () => Promise.resolve()
}))

import App from './App'

test('smoke - render app', async ()=>{
  let view
  await act(async () => {
    view = render(<App />)
  })

  expect(await screen.findByRole('heading', { name: /Vítejte v Rodině/i })).toBeInTheDocument()

  await act(async () => {
    view.unmount()
  })
})
