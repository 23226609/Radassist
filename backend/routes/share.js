// Public share links for a finalized report. Anyone with the token can read
// that one case — no login. Tokens are created from Review after finalize.

const router = require('express').Router();
const c = require('../controllers/caseController');

router.get('/:token', c.getSharedCase);
router.get('/:token/image', c.streamSharedImage);

module.exports = router;
