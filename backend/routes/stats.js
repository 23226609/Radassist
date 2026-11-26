// routes/stats.js
const router = require('express').Router();
const c = require('../controllers/statsController');
const { authenticate, denyPatient } = require('../middleware/auth');

router.use(authenticate);
router.use(denyPatient);
router.get('/', c.getStats);

module.exports = router;
