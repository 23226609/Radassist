// routes/images.js
const router = require('express').Router();
const c = require('../controllers/caseController');
const { authenticate } = require('../middleware/auth');

router.get('/:id', authenticate, c.streamImage);

module.exports = router;
