# media-link

One Lambda: a texted photo's Twilio ids in, the signed link Twilio redirects to out. Twilio
serves MMS media only to our credentials and answers an authenticated request with a redirect
to a link that works for anyone for about four hours. The resolver asks Twilio, does not
follow the redirect, and returns where it points; no bytes move and nothing is stored. A
workflow's `mintLinks` activity invokes it synchronously whenever it needs a fresh link (when
the model looks at the photo, and again when Facebook fetches it).

It takes ids, never a URL: the Twilio address is built here under our own account, so our
credentials can only ever go to Twilio. It refuses a photo not texted to the tenant's number
it is given, so one tenant's photo cannot be minted for another.

## Why it is its own function

It predates the worker: a Step Functions HTTP task could not read a redirect's Location
header, so the resolver had to be code beside the machine. The worker's activities can read a
redirect themselves, and they already hold the Twilio secret, so this function's reason to
stay separate is gone. Folding it into the activity, and deleting this package, is the next
step; nothing else depends on it.

## How to verify

```bash
npm test            # the resolver over a fake Twilio: the tenant check, the redirect, the refusal without a Location
npx tsx scripts/test-media-link.mts <tenantId> <MessageSid> <MediaSid>   # against Twilio, for a photo the tenant's number received
```
