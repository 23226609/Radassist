// routes/auth.js
const router = require('express').Router();
const c = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/login', c.login);
router.post('/register', c.register);
router.get('/me', authenticate, c.me);
router.post('/logout', authenticate, c.logout);

module.exports = router;
