module.exports = {
  spawn() {
    throw new Error("child_process is unavailable in the browser build.");
  },
};
