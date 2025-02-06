const express = require('express');
const router = express.Router();

// Render the index.ejs file located in the 'views' folder for the root route
router.get('/', (req, res) => {
  res.render('index');
});

module.exports = router;
