require('dotenv').config();

const cors = require('cors');
const express = require('express');
const healthRouter = require('./routers/health');

const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());
app.use('/api/health', healthRouter);

app.listen(port, () => {
  console.log(`Career Bridge API listening on port ${port}`);
});