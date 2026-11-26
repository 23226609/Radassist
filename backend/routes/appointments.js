// routes/appointments.js: a patient's own appointments. Patients only; staff use the case routes.
const router = require('express').Router();
const c = require('../controllers/appointmentController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.get('/', authorize('patient'), c.listMine);

module.exports = router;
