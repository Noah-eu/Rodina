import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

test('smoke - render app', ()=>{
  render(<App />)
  expect(screen.getByText(/Rodina/i)).toBeInTheDocument()
})
