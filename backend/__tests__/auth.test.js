const request = require('supertest');
const app = require('../src/testServer');

describe('Backend základní testy', ()=>{
  test('Můžeme vytvořit profil a přihlásit se', async ()=>{
    const name = 'TestUser'
    const pin = '1234'
    await request(app).post('/api/register').field('name', name).field('pin', pin)
    const res = await request(app).post('/api/login').send({ name, pin })
    expect(res.statusCode).toBe(200)
    expect(res.body.name).toBe(name)
  })
})
