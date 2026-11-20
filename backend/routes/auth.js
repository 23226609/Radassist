// routes/auth.js
const router = require('express').Router();
const c = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/auth');

router.post('/login', c.login);
// Only an administrator creates accounts. It used to be open to anyone.
router.post('/register', authenticate, authorize('admin'), c.register);
router.get('/me', authenticate, c.me);
router.post('/logout', authenticate, c.logout);

module.exports = router;
