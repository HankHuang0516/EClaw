#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NeedsYouWidgetStore, NSObject)

RCT_EXTERN_METHOD(setPendingCount:(nonnull NSNumber *)count
                  withResolver:(RCTPromiseResolveBlock)resolve
                  withRejecter:(RCTPromiseRejectBlock)reject)

@end
