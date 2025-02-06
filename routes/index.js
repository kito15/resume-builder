const express = require('express');
const path = require('path');
const router = express.Router();

// Serve the index.ejs template for the root route
router.get('/', (req, res) => {
  res.render('index');
});

module.exports = router;
