/**
 * Tests for the Lambda API routes (lambda.js)
 */

process.env.DB_MODE = 'sqlite';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../lambda');

const JWT_SECRET = 'test-secret';

function makeToken(email, options = {}) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h', ...options });
}

describe('API Routes', () => {
  // =========================================================================
  // Health Check
  // =========================================================================
  describe('GET /health', () => {
    it('should return status OK', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OK');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  // =========================================================================
  // 404 Handler
  // =========================================================================
  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(app).get('/api/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Route not found');
    });
  });

  // =========================================================================
  // Auth Routes
  // =========================================================================
  describe('Auth Routes', () => {
    describe('POST /api/auth/login', () => {
      it('should login with a valid email', async () => {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'api-test@example.com' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user).toBeDefined();
        expect(res.body.user.email).toBe('api-test@example.com');
      });

      it('should login again with the same email (existing user)', async () => {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'api-test@example.com' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
      });

      it('should return 400 for missing email', async () => {
        const res = await request(app)
          .post('/api/auth/login')
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
      });

      it('should return 400 for invalid email format', async () => {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'not-an-email' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
      });
    });

    describe('GET /api/auth/me', () => {
      it('should return the current user with a valid token', async () => {
        // First login to create the user
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'me-test@example.com' });

        const token = makeToken('me-test@example.com');
        const res = await request(app)
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.email).toBe('me-test@example.com');
      });

      it('should return 401 with no token', async () => {
        const res = await request(app).get('/api/auth/me');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('No token provided');
      });

      it('should return 401 with invalid token', async () => {
        const res = await request(app)
          .get('/api/auth/me')
          .set('Authorization', 'Bearer invalid-token');

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid token');
      });

      it('should return 401 with malformed Authorization header', async () => {
        const res = await request(app)
          .get('/api/auth/me')
          .set('Authorization', 'Token abc123');

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('No token provided');
      });

      it('should return 404 for token with non-existent user email', async () => {
        const token = makeToken('ghost@example.com');
        const res = await request(app)
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('User not found');
      });
    });
  });

  // =========================================================================
  // Client Routes
  // =========================================================================
  describe('Client Routes', () => {
    let token;
    let clientId;
    const userEmail = 'client-test@example.com';

    beforeAll(async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: userEmail });
      token = makeToken(userEmail);
    });

    describe('POST /api/clients', () => {
      it('should create a client', async () => {
        const res = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Test Client',
            description: 'A client for testing',
            department: 'QA',
            email: 'client@test.com'
          });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe('Test Client');
        expect(res.body.id).toBeDefined();
        clientId = res.body.id;
      });

      it('should return 400 for missing name', async () => {
        const res = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${token}`)
          .send({ description: 'No name' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
      });

      it('should return 401 without auth', async () => {
        const res = await request(app)
          .post('/api/clients')
          .send({ name: 'Unauth Client' });

        expect(res.status).toBe(401);
      });
    });

    describe('GET /api/clients', () => {
      it('should return all clients for the authenticated user', async () => {
        const res = await request(app)
          .get('/api/clients')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(1);
      });

      it('should return 401 without auth', async () => {
        const res = await request(app).get('/api/clients');
        expect(res.status).toBe(401);
      });
    });

    describe('GET /api/clients/:id', () => {
      it('should return a specific client', async () => {
        const res = await request(app)
          .get(`/api/clients/${clientId}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(clientId);
        expect(res.body.name).toBe('Test Client');
      });

      it('should return 404 for non-existent client', async () => {
        const res = await request(app)
          .get('/api/clients/non-existent')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Client not found');
      });

      it('should return 404 for client belonging to another user', async () => {
        // Create another user and client
        const otherEmail = 'other-client-user@example.com';
        await request(app)
          .post('/api/auth/login')
          .send({ email: otherEmail });
        const otherToken = makeToken(otherEmail);
        const createRes = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${otherToken}`)
          .send({ name: 'Other User Client' });

        // Try to access with our token
        const res = await request(app)
          .get(`/api/clients/${createRes.body.id}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
      });
    });

    describe('PUT /api/clients/:id', () => {
      it('should update a client', async () => {
        const res = await request(app)
          .put(`/api/clients/${clientId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Updated Client',
            description: 'Updated desc',
            department: 'Dev',
            email: 'updated@test.com'
          });

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Updated Client');
      });

      it('should return 400 for invalid data', async () => {
        const res = await request(app)
          .put(`/api/clients/${clientId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: '' });

        expect(res.status).toBe(400);
      });

      it('should return 404 for non-existent client', async () => {
        const res = await request(app)
          .put('/api/clients/non-existent')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Nope' });

        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/clients/:id', () => {
      it('should delete a client', async () => {
        // Create a client to delete
        const createRes = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'To Delete Client' });

        const res = await request(app)
          .delete(`/api/clients/${createRes.body.id}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(204);

        // Verify it's gone
        const getRes = await request(app)
          .get(`/api/clients/${createRes.body.id}`)
          .set('Authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(404);
      });

      it('should return 404 for non-existent client', async () => {
        const res = await request(app)
          .delete('/api/clients/non-existent')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
      });
    });
  });

  // =========================================================================
  // Work Entry Routes
  // =========================================================================
  describe('Work Entry Routes', () => {
    let token;
    let clientId;
    let entryId;
    const userEmail = 'entry-test@example.com';

    beforeAll(async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: userEmail });
      token = makeToken(userEmail);

      const clientRes = await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Entry Test Client' });
      clientId = clientRes.body.id;
    });

    describe('POST /api/work-entries', () => {
      it('should create a work entry', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 8,
            description: 'API testing',
            date: '2024-06-15'
          });

        expect(res.status).toBe(201);
        expect(res.body.client_id).toBe(clientId);
        expect(res.body.hours).toBe(8);
        expect(res.body.id).toBeDefined();
        entryId = res.body.id;
      });

      it('should return 400 for missing required fields', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({ client_id: clientId });

        expect(res.status).toBe(400);
      });

      it('should return 400 for invalid hours (zero)', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 0,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
      });

      it('should return 400 for hours exceeding 24', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 25,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
      });

      it('should return 400 for invalid date format', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 4,
            date: 'not-a-date'
          });

        expect(res.status).toBe(400);
      });

      it('should return 400 for a client belonging to another user', async () => {
        const otherEmail = 'other-entry-user@example.com';
        await request(app)
          .post('/api/auth/login')
          .send({ email: otherEmail });
        const otherToken = makeToken(otherEmail);
        const otherClient = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${otherToken}`)
          .send({ name: 'Other Entry Client' });

        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: otherClient.body.id,
            hours: 4,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid client');
      });

      it('should return 400 for non-existent client_id', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: 'fake-client-id',
            hours: 4,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid client');
      });

      it('should return 401 without auth', async () => {
        const res = await request(app)
          .post('/api/work-entries')
          .send({
            client_id: clientId,
            hours: 4,
            date: '2024-06-15'
          });

        expect(res.status).toBe(401);
      });
    });

    describe('GET /api/work-entries', () => {
      it('should return all work entries for the authenticated user', async () => {
        const res = await request(app)
          .get('/api/work-entries')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(1);
      });

      it('should return 401 without auth', async () => {
        const res = await request(app).get('/api/work-entries');
        expect(res.status).toBe(401);
      });
    });

    describe('GET /api/work-entries/:id', () => {
      it('should return a specific work entry', async () => {
        const res = await request(app)
          .get(`/api/work-entries/${entryId}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(entryId);
      });

      it('should return 404 for non-existent entry', async () => {
        const res = await request(app)
          .get('/api/work-entries/non-existent')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
      });

      it('should return 404 for entry belonging to another user', async () => {
        const otherEmail = 'other-entry-viewer@example.com';
        await request(app)
          .post('/api/auth/login')
          .send({ email: otherEmail });
        const otherToken = makeToken(otherEmail);

        const res = await request(app)
          .get(`/api/work-entries/${entryId}`)
          .set('Authorization', `Bearer ${otherToken}`);

        expect(res.status).toBe(404);
      });
    });

    describe('PUT /api/work-entries/:id', () => {
      it('should update a work entry', async () => {
        const res = await request(app)
          .put(`/api/work-entries/${entryId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 6,
            description: 'Updated entry',
            date: '2024-06-20'
          });

        expect(res.status).toBe(200);
        expect(res.body.hours).toBe(6);
        expect(res.body.description).toBe('Updated entry');
      });

      it('should return 404 for non-existent entry', async () => {
        const res = await request(app)
          .put('/api/work-entries/non-existent')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 4,
            date: '2024-06-15'
          });

        expect(res.status).toBe(404);
      });

      it('should return 400 for invalid data', async () => {
        const res = await request(app)
          .put(`/api/work-entries/${entryId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: -1,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
      });

      it('should return 400 when updating to a client belonging to another user', async () => {
        const otherEmail = 'other-entry-update@example.com';
        await request(app)
          .post('/api/auth/login')
          .send({ email: otherEmail });
        const otherToken = makeToken(otherEmail);
        const otherClient = await request(app)
          .post('/api/clients')
          .set('Authorization', `Bearer ${otherToken}`)
          .send({ name: 'Other Update Client' });

        const res = await request(app)
          .put(`/api/work-entries/${entryId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: otherClient.body.id,
            hours: 4,
            date: '2024-06-15'
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid client');
      });
    });

    describe('DELETE /api/work-entries/:id', () => {
      it('should delete a work entry', async () => {
        // Create one to delete
        const createRes = await request(app)
          .post('/api/work-entries')
          .set('Authorization', `Bearer ${token}`)
          .send({
            client_id: clientId,
            hours: 2,
            date: '2024-06-21'
          });

        const res = await request(app)
          .delete(`/api/work-entries/${createRes.body.id}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(204);

        // Verify it's gone
        const getRes = await request(app)
          .get(`/api/work-entries/${createRes.body.id}`)
          .set('Authorization', `Bearer ${token}`);
        expect(getRes.status).toBe(404);
      });

      it('should return 404 for non-existent entry', async () => {
        const res = await request(app)
          .delete('/api/work-entries/non-existent')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
      });
    });
  });
});
