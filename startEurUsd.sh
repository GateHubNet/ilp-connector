#!/bin/bash

DEBUG='*' CONNECTOR_LEDGERS='{

  "dcd15f97-9b44-4e4b-8a2e-b87313a43d73.9c164c67-cc6d-424b-add5-8783a417e282.": {
    "currency": "EUR",
    "plugin": "@interledger/plugin",
    "options": {
      "urls": {
          "ilpUrl": "http://127.0.0.1:9001",
          "coreUrl": "http://localhost:8080/v1",
          "notificationsUrl": "/notifications"
      },
      "account": "dcd15f97-9b44-4e4b-8a2e-b87313a43d73.9c164c67-cc6d-424b-add5-8783a417e282.e5c31443-f4c8-a2d0-cdba-80c593feb378.88752309"
    }
  },

  "dcd15f97-9b44-4e4b-8a2e-b87313a43d73.a96a4b2d-a7dc-4c1c-a9ac-3e96c95d688a.": {
    "currency": "USD",
    "plugin": "@interledger/plugin",
    "options": {
      "urls": {
          "ilpUrl": "http://127.0.0.1:9001",
          "coreUrl": "http://localhost:9002/v1",
          "notificationsUrl": "/notifications"
      },
      "account": "dcd15f97-9b44-4e4b-8a2e-b87313a43d73.a96a4b2d-a7dc-4c1c-a9ac-3e96c95d688a.c1c19d27-faf7-d7c5-82a3-920ea2bb0b51.45182911"
    }
  }

}' CONNECTOR_BACKEND='@interledger/backend' node src/index.js
