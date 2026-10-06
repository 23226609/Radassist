// routes/cases.js
const router = require('express').Router();
const c = require('../controllers/caseController');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(authenticate);

router.get('/', c.listCases);
router.post('/request', authorize('doctor', 'admin'), c.requestExam);
router.post('/', authorize('technician', 'admin'), upload.single('file'), c.createCase);
router.post('/bulk-delete', authorize('admin'), c.deleteCases);
router.get('/:id', c.getCase);
router.put('/:id', authorize('radiologist', 'admin'), c.updateCase);
router.post('/:id/analyze', authorize('radiologist', 'admin'), c.analyzeCase);
router.post('/:id/finalize', authorize('radiologist', 'admin'), c.finalizeCase);
router.post('/:id/share', authorize('radiologist', 'admin'), c.createShareLink);
router.delete('/:id/share', authorize('radiologist', 'admin'), c.revokeShareLink);
router.post('/:id/summarise-findings', authorize('radiologist', 'admin'), c.summariseFindings);
router.post('/:id/summarise-diagnosis', authorize('radiologist', 'admin'), c.summariseDiagnosis);
router.delete('/:id', authorize('admin'), c.deleteCase);

module.exports = router;
