// routes/stats.js
const router = require('express').Router();
const c = require('../controllers/statsController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);
router.get('/', c.getStats);

module.exports = router;
