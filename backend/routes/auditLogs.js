// routes/auditLogs.js
const router = require('express').Router();
const c = require('../controllers/auditLogController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.get('/', authorize('admin', 'doctor'), c.listLogs);

module.exports = router;
