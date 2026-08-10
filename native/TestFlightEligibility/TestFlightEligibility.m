#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(TestFlightEligibility, NSObject)

RCT_EXTERN_METHOD(getCredentialDisplayInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
