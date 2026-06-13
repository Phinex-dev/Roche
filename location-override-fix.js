// Compatibility patch for delivery builds without source maps.
// Group chat time formatting currently reads memberOverrides[id].locationOverride,
// while the settings UI persists memberOverrides[id].location.
(function () {
  var proto = Object.prototype;
  var existing = Object.getOwnPropertyDescriptor(proto, "locationOverride");

  if (existing && !existing.configurable) {
    return;
  }

  // Limit the fallback to IANA timezone strings like "Asia/Shanghai".
  var ianaTimeZonePattern = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;

  Object.defineProperty(proto, "locationOverride", {
    configurable: true,
    enumerable: false,
    get: function () {
      if (!this || typeof this !== "object") {
        return undefined;
      }

      var value = this.location;
      if (typeof value === "string" && ianaTimeZonePattern.test(value)) {
        return value;
      }

      return undefined;
    },
    set: function (value) {
      Object.defineProperty(this, "locationOverride", {
        value: value,
        writable: true,
        configurable: true,
        enumerable: true
      });
    }
  });
})();
