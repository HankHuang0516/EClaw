import Foundation
import WidgetKit
import React

@objc(NeedsYouWidgetStore)
class NeedsYouWidgetStore: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(setPendingCount:withResolver:withRejecter:)
  func setPendingCount(
    _ count: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let defaults = UserDefaults(suiteName: "__APP_GROUP__") else {
      reject("ERR_NEEDS_YOU_WIDGET_STORE", "Unable to open Needs-you app group defaults", nil)
      return
    }

    let clampedCount = max(0, count.intValue)
    defaults.set(clampedCount, forKey: "__PENDING_COUNT_KEY__")
    defaults.set(Date().timeIntervalSince1970, forKey: "__UPDATED_AT_KEY__")
    defaults.synchronize()

    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadTimelines(ofKind: "__WIDGET_KIND__")
    }

    resolve(true)
  }
}
