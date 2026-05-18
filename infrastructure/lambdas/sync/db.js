const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const { sleep } = require('./utils');

const client = new DynamoDBClient({});

/**
 * Batch-write up to 25 requests per call, with retry on UnprocessedItems.
 * Caller passes an array of `{ PutRequest: ... }` / `{ DeleteRequest: ... }` items.
 */
async function batchWrite(tableName, requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let batch = requests.slice(i, i + 25);
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await client.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: batch } }));
      const un = res.UnprocessedItems?.[tableName];
      if (!un || un.length === 0) break;
      batch = un;
      await sleep(40 * (attempt + 1));
    }
  }
}

module.exports = { client, batchWrite };
