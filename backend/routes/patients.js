const router = require('express').Router();
const c = require('../controllers/patientController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', c.listPatients);
router.get('/:id', c.getPatient);
router.put('/:id', authorize('doctor', 'admin'), c.updatePatient);

module.exports = router;
