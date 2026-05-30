#!/usr/bin/env node
'use strict';

require('../backend/scripts/petdx-phase0-backfill')
    .main()
    .catch((err) => {
        console.error('[petdx-phase0-backfill] fatal:', err.message);
        process.exit(1);
    });
