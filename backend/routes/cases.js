// routes/cases.js
const router = require('express').Router();
const c = require('../controllers/caseController');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(authenticate);

router.get('/', c.listCases);
router.get('/:id', c.getCase);
router.post('/', authorize('doctor', 'admin'), upload.single('file'), c.createCase);
router.put('/:id', authorize('doctor', 'admin'), c.updateCase);
router.post('/:id/finalize', authorize('doctor', 'admin'), c.finalizeCase);
router.post('/:id/summarise-findings', authorize('doctor', 'admin'), c.summariseFindings);
router.post('/:id/summarise-diagnosis', authorize('doctor', 'admin'), c.summariseDiagnosis);
router.post('/bulk-delete', authorize('admin'), c.deleteCases);
router.delete('/:id', authorize('admin'), c.deleteCase);

module.exports = router;
