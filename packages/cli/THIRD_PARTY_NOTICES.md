# Third-party notices

The Candle CLI is MIT licensed (see LICENSE). It includes the following third-party material
under its own licence.

## EFF long wordlist

`src/vault/eff-wordlist.ts` holds the 7,776 words of the Electronic Frontier Foundation's long
wordlist, with the dice numbers removed. The CLI uses it to generate vault passphrases.

- Source: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt
- Author: Electronic Frontier Foundation, https://www.eff.org/dice
- Licence: Creative Commons Attribution 3.0 United States (CC BY 3.0 US),
  https://creativecommons.org/licenses/by/3.0/us/
- Changes: the dice-roll numbers were dropped and the words stored as a TypeScript array.
