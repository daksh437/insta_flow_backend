function isIndexMissingError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toUpperCase();
  return (
    code.includes('FAILED_PRECONDITION') ||
    code === '9' ||
    message.includes('FAILED_PRECONDITION') ||
    message.includes('QUERY REQUIRES AN INDEX')
  );
}

function logIndexRequirement({ queryName, collection, fields, error }) {
  const fieldList = Array.isArray(fields) ? fields.join(', ') : String(fields || '');
  console.error('Firestore index missing:', error?.message || error);
  console.error(
    `[FirestoreIndex] query=${queryName} collection=${collection} requiredCompositeIndexFields=[${fieldList}]`
  );
}

module.exports = {
  isIndexMissingError,
  logIndexRequirement,
};
