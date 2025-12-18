/**
 * In-memory job storage for async operations
 * In production, replace with Redis or database
 */

const jobs = new Map();

/**
 * Create a new job
 * @param {string} jobId - Unique job identifier
 * @param {object} initialData - Initial job data
 * @returns {object} Job object
 */
function createJob(jobId, initialData = {}) {
  const job = {
    jobId,
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...initialData,
  };
  jobs.set(jobId, job);
  console.log(`[JobStore] Created job: ${jobId}, status: processing`);
  return job;
}

/**
 * Get job by ID
 * @param {string} jobId - Job identifier
 * @returns {object|null} Job object or null if not found
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Update job status and data
 * @param {string} jobId - Job identifier
 * @param {string} status - New status ('processing' | 'completed' | 'failed')
 * @param {object} data - Additional data to store
 */
function updateJob(jobId, status, data = {}) {
  const job = jobs.get(jobId);
  if (!job) {
    console.warn(`[JobStore] Job not found: ${jobId}`);
    return null;
  }
  
  job.status = status;
  job.updatedAt = new Date().toISOString();
  Object.assign(job, data);
  
  jobs.set(jobId, job);
  console.log(`[JobStore] Updated job: ${jobId}, status: ${status}`);
  return job;
}

/**
 * Delete job (cleanup after completion)
 * @param {string} jobId - Job identifier
 */
function deleteJob(jobId) {
  jobs.delete(jobId);
  console.log(`[JobStore] Deleted job: ${jobId}`);
}

/**
 * Cleanup old jobs (older than 1 hour)
 * Run periodically to prevent memory leaks
 */
function cleanupOldJobs() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [jobId, job] of jobs.entries()) {
    const createdAt = new Date(job.createdAt).getTime();
    if (createdAt < oneHourAgo) {
      jobs.delete(jobId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[JobStore] Cleaned up ${cleaned} old jobs`);
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldJobs, 30 * 60 * 1000);

/**
 * Generate unique job ID
 * @returns {string} Unique job identifier
 */
function generateJobId() {
  return `REELS-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  deleteJob,
  generateJobId,
  cleanupOldJobs,
};

