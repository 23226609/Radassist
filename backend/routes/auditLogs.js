// routes/auditLogs.js
const router = require('express').Router();
const c = require('../controllers/auditLogController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.get('/', authorize('admin', 'doctor'), c.listLogs);
router.post('/bulk-delete', authorize('admin'), c.deleteLogs);
router.delete('/:id', authorize('admin'), c.deleteLog);

module.exports = router;
