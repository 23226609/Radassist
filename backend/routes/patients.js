const router = require('express').Router();
const c = require('../controllers/patientController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', c.listPatients);
router.get('/:id', c.getPatient);
router.put('/:id', authorize('doctor', 'admin'), c.updatePatient);
router.post('/bulk-delete', authorize('admin'), c.deletePatients);
router.delete('/:id', authorize('admin'), c.deletePatient);

module.exports = router;
