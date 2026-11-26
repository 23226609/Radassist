// routes/images.js
const router = require('express').Router();
const c = require('../controllers/caseController');
const { authenticate, denyPatient } = require('../middleware/auth');

router.get('/:id', authenticate, denyPatient, c.streamImage);

module.exports = router;
