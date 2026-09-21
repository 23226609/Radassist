// routes/users.js
const router = require('express').Router();
const c = require('../controllers/userController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.get('/', authorize('admin'), c.listUsers);
router.put('/:id/active', authorize('admin'), c.setUserActive);

module.exports = router;
