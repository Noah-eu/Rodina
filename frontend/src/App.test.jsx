import { render, screen } from '@testing-library/react'
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

test('smoke - render app', ()=>{
  render(<App />)
  expect(screen.getByRole('heading', { name: /Vítejte v Rodině/i })).toBeInTheDocument()
})
