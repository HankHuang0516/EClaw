'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const fs = require('fs');

module.exports = function () {
  const router = express.Router();

  const specPath = path.join(__dirname, 'openapi.yaml');
  const swaggerDocument = YAML.load(specPath);

  // Serve raw spec
  router.get('/openapi.yaml', (req, res) => {
    res.type('text/yaml').send(fs.readFileSync(specPath, 'utf8'));
  });
  router.get('/openapi.json', (req, res) => {
    res.json(swaggerDocument);
  });

  // Swagger UI
  router.use('/', swaggerUi.serve);
  router.get('/', swaggerUi.setup(swaggerDocument, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'EClaw API Documentation'
  }));

  return { router };
};
