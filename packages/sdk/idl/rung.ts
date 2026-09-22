/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/rung.json`.
 */
export type Rung = {
  "address": "6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM",
  "metadata": {
    "name": "rung",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Rung — a capital-backed valuation market for PreStocks on Solana"
  },
  "instructions": [
    {
      "name": "acceptCommitment",
      "docs": [
        "Taker (protection buyer) locks stock and pays the premium, for part or all of a",
        "commitment. Creates one `Fill`: their own claim on that slice of the collateral."
      ],
      "discriminator": [
        14,
        249,
        220,
        223,
        195,
        182,
        252,
        156
      ],
      "accounts": [
        {
          "name": "taker",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position.stockMint",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "position.maker",
                "account": "position"
              },
              {
                "kind": "account",
                "path": "position.nonce",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "fill",
          "docs": [
            "This taker's claim on the commitment. Indexed by `position.fills_created`, which only",
            "ever increases, so a settled fill's address is never handed out again."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "account",
                "path": "position.fillsCreated",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "stockMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "takerStockAccount",
          "writable": true
        },
        {
          "name": "takerQuoteAccount",
          "writable": true
        },
        {
          "name": "makerQuoteAccount",
          "docs": [
            "The premium lands here directly. The protocol never takes custody of it, so there is",
            "no path by which a matched maker fails to be paid."
          ],
          "writable": true
        },
        {
          "name": "feeTreasuryAccount",
          "docs": [
            "The protocol's cut of the premium. Created on demand so a treasury that has never",
            "held the quote mint cannot make matching fail."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "feeTreasury"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeTreasury"
        },
        {
          "name": "stockVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockTokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "stockRawToSend",
          "type": "u64"
        },
        {
          "name": "fillStrikeQuote",
          "type": "u64"
        }
      ]
    },
    {
      "name": "addMarket",
      "docs": [
        "Allowlist a PreStock mint. Admin-only: the PreStocks API is discovery, not consent."
      ],
      "discriminator": [
        41,
        137,
        185,
        126,
        69,
        139,
        254,
        55
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ]
          }
        },
        {
          "name": "stockMint"
        },
        {
          "name": "stockTokenProgram",
          "docs": [
            "Pinned into the market so this mint can only ever be moved by this program."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "symbol",
          "type": "string"
        }
      ]
    },
    {
      "name": "cancelCommitment",
      "discriminator": [
        36,
        39,
        70,
        137,
        71,
        179,
        88,
        232
      ],
      "accounts": [
        {
          "name": "maker",
          "signer": true,
          "relations": [
            "position"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "position.nonce",
                "account": "position"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "quoteMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "makerQuoteAccount",
          "writable": true
        },
        {
          "name": "quoteTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "createCommitment",
      "docs": [
        "Maker (valuation buyer) locks USDC against a target valuation."
      ],
      "discriminator": [
        232,
        31,
        118,
        65,
        229,
        2,
        2,
        170
      ],
      "accounts": [
        {
          "name": "maker",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "docs": [
            "program-derived authority rather than any keypair a human could hold."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "stockMint"
        },
        {
          "name": "quoteMint"
        },
        {
          "name": "makerQuoteAccount",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockVault",
          "docs": [
            "Created now, while the maker is already paying rent, so accepting is a single",
            "transfer for the taker and cannot fail on a missing vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockTokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "stockRawRequired",
          "type": "u64"
        },
        {
          "name": "strikeQuoteAmount",
          "type": "u64"
        },
        {
          "name": "premiumQuoteAmount",
          "type": "u64"
        },
        {
          "name": "expiryTs",
          "type": "i64"
        },
        {
          "name": "targetValuationUsd",
          "type": "u64"
        }
      ]
    },
    {
      "name": "exerciseFill",
      "docs": [
        "Taker swaps their fill's escrowed stock for its escrowed USDC. Only they may call it."
      ],
      "discriminator": [
        52,
        73,
        27,
        43,
        249,
        34,
        138,
        3
      ],
      "accounts": [
        {
          "name": "taker",
          "writable": true,
          "signer": true,
          "relations": [
            "fill"
          ]
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "position.maker",
                "account": "position"
              },
              {
                "kind": "account",
                "path": "position.nonce",
                "account": "position"
              }
            ]
          },
          "relations": [
            "fill"
          ]
        },
        {
          "name": "fill",
          "docs": [
            "Closed once settled: the claim is spent, and its rent goes back to the taker who",
            "paid it at match."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "account",
                "path": "fill.index",
                "account": "fill"
              }
            ]
          }
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "maker"
        },
        {
          "name": "stockMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "takerQuoteAccount",
          "writable": true
        },
        {
          "name": "makerStockAccount",
          "docs": [
            "The maker may never have held this PreStock before, so the receiving account is",
            "created on demand rather than making exercise fail on a missing account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockTokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "expireFill",
      "docs": [
        "Return both collaterals for one fill after expiry. Permissionless."
      ],
      "discriminator": [
        84,
        213,
        233,
        58,
        211,
        66,
        197,
        101
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Anyone. They pay the transaction fee and any rent for the receiving accounts."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "position.maker",
                "account": "position"
              },
              {
                "kind": "account",
                "path": "position.nonce",
                "account": "position"
              }
            ]
          },
          "relations": [
            "fill"
          ]
        },
        {
          "name": "fill",
          "docs": [
            "Closed once settled. Its rent goes back to the taker who paid it at match, not to",
            "whoever happened to crank the expiry."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "position"
              },
              {
                "kind": "account",
                "path": "fill.index",
                "account": "fill"
              }
            ]
          }
        },
        {
          "name": "maker",
          "writable": true
        },
        {
          "name": "taker",
          "writable": true,
          "relations": [
            "fill"
          ]
        },
        {
          "name": "positionAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "stockMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteMint",
          "relations": [
            "position"
          ]
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "positionAuthority"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "makerQuoteAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "quoteTokenProgram"
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "takerStockAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "taker"
              },
              {
                "kind": "account",
                "path": "stockTokenProgram"
              },
              {
                "kind": "account",
                "path": "stockMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "stockTokenProgram"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "quoteMint"
        },
        {
          "name": "quoteTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "setFee",
      "docs": [
        "Set the protocol's cut of the premium, in basis points, and where it is paid."
      ],
      "discriminator": [
        18,
        154,
        24,
        18,
        237,
        214,
        19,
        80
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeTreasury"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setMarketEnabled",
      "discriminator": [
        206,
        60,
        159,
        159,
        62,
        242,
        4,
        82
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.stockMint",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "enabled",
          "type": "bool"
        },
        {
          "name": "acceptEnabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setMinFill",
      "docs": [
        "Set the smallest fill, and the smallest remainder a fill may leave behind."
      ],
      "discriminator": [
        148,
        229,
        43,
        33,
        106,
        190,
        44,
        180
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "minFillQuote",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "fill",
      "discriminator": [
        246,
        116,
        142,
        122,
        204,
        199,
        44,
        113
      ]
    },
    {
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    }
  ],
  "events": [
    {
      "name": "commitmentCancelled",
      "discriminator": [
        53,
        49,
        7,
        194,
        190,
        210,
        188,
        126
      ]
    },
    {
      "name": "commitmentCreated",
      "discriminator": [
        179,
        58,
        10,
        188,
        241,
        19,
        191,
        229
      ]
    },
    {
      "name": "commitmentMatched",
      "discriminator": [
        197,
        17,
        155,
        157,
        130,
        72,
        65,
        78
      ]
    },
    {
      "name": "positionExercised",
      "discriminator": [
        25,
        164,
        68,
        6,
        13,
        43,
        42,
        185
      ]
    },
    {
      "name": "positionExpiredEvent",
      "discriminator": [
        76,
        64,
        145,
        0,
        122,
        193,
        241,
        81
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidMarket",
      "msg": "Market is not registered for this stock mint"
    },
    {
      "code": 6001,
      "name": "marketDisabled",
      "msg": "Market is disabled for new commitments"
    },
    {
      "code": 6002,
      "name": "marketAcceptDisabled",
      "msg": "Market is disabled for new matches"
    },
    {
      "code": 6003,
      "name": "invalidState",
      "msg": "Position is not in the required state for this action"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "Signer is not authorized for this action"
    },
    {
      "code": 6005,
      "name": "invalidExpiry",
      "msg": "Expiry must be between the minimum and maximum horizon"
    },
    {
      "code": 6006,
      "name": "positionExpired",
      "msg": "Position has passed its expiry"
    },
    {
      "code": 6007,
      "name": "positionNotExpired",
      "msg": "Position has not yet reached its expiry"
    },
    {
      "code": 6008,
      "name": "invalidStockMint",
      "msg": "Stock mint does not match the position"
    },
    {
      "code": 6009,
      "name": "invalidQuoteMint",
      "msg": "Quote mint does not match the protocol quote mint"
    },
    {
      "code": 6010,
      "name": "invalidTokenProgram",
      "msg": "Token program does not match the one registered for this market"
    },
    {
      "code": 6011,
      "name": "invalidAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6012,
      "name": "insufficientCollateral",
      "msg": "Vault received less collateral than the position requires"
    },
    {
      "code": 6013,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6014,
      "name": "globalPause",
      "msg": "Protocol is paused for new commitments and matches"
    },
    {
      "code": 6015,
      "name": "symbolTooLong",
      "msg": "Symbol exceeds the maximum length"
    },
    {
      "code": 6016,
      "name": "strikeAboveCap",
      "msg": "Strike exceeds the per-position cap"
    },
    {
      "code": 6017,
      "name": "transferHookSet",
      "msg": "Stock mint has a transfer hook set, which this program cannot yet settle through"
    },
    {
      "code": 6018,
      "name": "selfMatch",
      "msg": "A maker cannot take the other side of their own commitment"
    },
    {
      "code": 6019,
      "name": "fillTooSmall",
      "msg": "Fill is below the minimum and does not take the whole remainder"
    },
    {
      "code": 6020,
      "name": "fillRemainderTooSmall",
      "msg": "Fill would leave an open remainder below the minimum"
    },
    {
      "code": 6021,
      "name": "fillExceedsOpen",
      "msg": "Fill is larger than the commitment's open amount"
    },
    {
      "code": 6022,
      "name": "nothingOpen",
      "msg": "Commitment has no open amount left to take or withdraw"
    },
    {
      "code": 6023,
      "name": "feeTooHigh",
      "msg": "Fee exceeds the maximum basis points"
    }
  ],
  "types": [
    {
      "name": "commitmentCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "quoteReturned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "commitmentCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "stockMint",
            "type": "pubkey"
          },
          {
            "name": "stockRawRequired",
            "type": "u64"
          },
          {
            "name": "strikeQuoteEscrowed",
            "type": "u64"
          },
          {
            "name": "premiumQuoteAmount",
            "type": "u64"
          },
          {
            "name": "targetValuationUsd",
            "type": "u64"
          },
          {
            "name": "expiryTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "commitmentMatched",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "fill",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "fillIndex",
            "type": "u32"
          },
          {
            "name": "strikeQuoteAmount",
            "type": "u64"
          },
          {
            "name": "stockRawSent",
            "type": "u64"
          },
          {
            "name": "stockRawEscrowed",
            "docs": [
              "Smaller than `stock_raw_sent` whenever a transfer fee applies."
            ],
            "type": "u64"
          },
          {
            "name": "premiumPaid",
            "type": "u64"
          },
          {
            "name": "feePaid",
            "type": "u64"
          },
          {
            "name": "strikeQuoteOpen",
            "docs": [
              "What is left open on the commitment after this fill."
            ],
            "type": "u64"
          },
          {
            "name": "matchedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fill",
      "docs": [
        "One taker's claim on part of a commitment."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "index",
            "docs": [
              "Index within the position, from `Position.fills_created`."
            ],
            "type": "u32"
          },
          {
            "name": "strikeQuoteAmount",
            "docs": [
              "This fill's claim on the quote vault if it is exercised."
            ],
            "type": "u64"
          },
          {
            "name": "stockRawRequired",
            "docs": [
              "Stock this fill had to deliver, before the mint's transfer fee."
            ],
            "type": "u64"
          },
          {
            "name": "stockRawEscrowed",
            "docs": [
              "Stock the vault actually received for it. This is what settlement pays out."
            ],
            "type": "u64"
          },
          {
            "name": "premiumPaid",
            "docs": [
              "Premium the taker paid, before the protocol fee was taken out of it."
            ],
            "type": "u64"
          },
          {
            "name": "feePaid",
            "type": "u64"
          },
          {
            "name": "matchedAt",
            "type": "i64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "fillStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "fillStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "matched"
          },
          {
            "name": "exercised"
          },
          {
            "name": "expired"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "docs": [
              "The single settlement currency. Every strike and premium is denominated in it."
            ],
            "type": "pubkey"
          },
          {
            "name": "quoteTokenProgram",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Halts new commitments and new matches. Deliberately does NOT halt settlement —",
              "see `exercise_fill` for why pausing must never strand escrowed collateral."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "feeBps",
            "docs": [
              "Protocol cut of the premium at match, in basis points, capped at `MAX_FEE_BPS`."
            ],
            "type": "u16"
          },
          {
            "name": "feeTreasury",
            "docs": [
              "Owner of the token account the fee is paid into."
            ],
            "type": "pubkey"
          },
          {
            "name": "minFillQuote",
            "docs": [
              "Smallest fill, in raw quote units, except when a fill takes the whole remainder.",
              "Also the smallest remainder a fill may leave behind. Zero disables both checks."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "market",
      "docs": [
        "Allowlist entry for one PreStock.",
        "",
        "The PreStocks API is discovery, not authorization (spec §48): anything it returns is a",
        "suggestion, and only a `Market` created by the admin makes a mint eligible for escrow.",
        "This is what stops a lookalike mint from being passed off as the real token."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stockMint",
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "docs": [
              "Pinned at registration. PreStocks are Token-2022, but binding it explicitly means a",
              "mint cannot later be serviced by an unexpected program."
            ],
            "type": "pubkey"
          },
          {
            "name": "symbol",
            "docs": [
              "Right-padded ticker, carried purely so indexers can group without a side table."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "enabled",
            "docs": [
              "Gates `create_commitment`."
            ],
            "type": "bool"
          },
          {
            "name": "acceptEnabled",
            "docs": [
              "Gates `accept_commitment` independently, so a market can be wound down by letting",
              "open commitments drain rather than stranding them (spec §50)."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "A maker's offer of capital at a valuation, and the owner of both vaults.",
        "",
        "The terms are fixed at creation. Takers claim slices of it through `Fill` accounts, each",
        "inheriting these terms pro rata; see docs/fills.md."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "stockMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "stockTokenProgram",
            "type": "pubkey"
          },
          {
            "name": "quoteTokenProgram",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "Maker-chosen, making the position PDA collision-free without a global counter."
            ],
            "type": "u64"
          },
          {
            "name": "stockRawRequired",
            "docs": [
              "Stock the vault must hold for the commitment to be taken in full.",
              "",
              "Raw base units, never UI amounts: a ScaledUiAmount multiplier change rescales what a",
              "UI amount means, while the raw figure stays a fixed claim on the vault."
            ],
            "type": "u64"
          },
          {
            "name": "stockRawEscrowed",
            "docs": [
              "Raw stock the vault actually holds across every open fill. This is what settlement",
              "pays out.",
              "",
              "It is measured rather than assumed because the Token-2022 transfer fee makes the",
              "amount that arrives strictly smaller than the amount sent, by a rate that can change",
              "at an epoch boundary."
            ],
            "type": "u64"
          },
          {
            "name": "strikeQuoteAmount",
            "type": "u64"
          },
          {
            "name": "strikeQuoteEscrowed",
            "docs": [
              "Quote measured into the vault at creation. Every fill is sized against this, so a",
              "claim is always denominated in money that is actually there."
            ],
            "type": "u64"
          },
          {
            "name": "strikeQuoteOpen",
            "docs": [
              "The part of `strike_quote_escrowed` no taker has claimed yet."
            ],
            "type": "u64"
          },
          {
            "name": "premiumQuoteAmount",
            "type": "u64"
          },
          {
            "name": "expiryTs",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "firstMatchedAt",
            "docs": [
              "Zero until the corresponding transition occurs."
            ],
            "type": "i64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "targetValuationUsd",
            "docs": [
              "Company valuation, in whole USD, that the maker was targeting at creation.",
              "",
              "Metadata only, and never consulted during settlement (spec §13). It is kept on-chain",
              "so the Commitment Curve can be rebuilt from chain state alone rather than trusting an",
              "indexer's private notion of what each position meant."
            ],
            "type": "u64"
          },
          {
            "name": "fillsCreated",
            "docs": [
              "Monotonic, and the fill PDAs' index. Never decremented, so a closed fill's address is",
              "never reused."
            ],
            "type": "u32"
          },
          {
            "name": "fillsOpen",
            "docs": [
              "Fills that have not settled yet."
            ],
            "type": "u32"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "positionStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "authorityBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "positionExercised",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "fill",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "quoteToTaker",
            "type": "u64"
          },
          {
            "name": "stockToMaker",
            "type": "u64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "positionExpiredEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "fill",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "quoteToMaker",
            "type": "u64"
          },
          {
            "name": "stockToTaker",
            "type": "u64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "positionStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "partiallyMatched"
          },
          {
            "name": "matched"
          },
          {
            "name": "settled"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "fillSeed",
      "type": "bytes",
      "value": "[102, 105, 108, 108]"
    },
    {
      "name": "marketSeed",
      "type": "bytes",
      "value": "[109, 97, 114, 107, 101, 116]"
    },
    {
      "name": "maxFeeBps",
      "docs": [
        "Ceiling on the protocol fee, in basis points of the premium.",
        "",
        "The admin sets the fee, so the cap is what stops a compromised admin key from taking a",
        "maker's entire income at the moment of a match. It binds the fee alone: collateral is",
        "never a fee's source, whatever this is set to."
      ],
      "type": "u16",
      "value": "500"
    },
    {
      "name": "maxStrikeWholeUnits",
      "docs": [
        "Launch guardrail: the most quote currency, in whole units (dollars, for USDC), that one",
        "position may lock.",
        "",
        "The program is unaudited and holds real funds on mainnet. A cap does not make a bug less",
        "likely, it bounds what any one position can lose to one. Scaled by the quote mint's own",
        "decimals at runtime, so it means the same thing whatever that mint is. Raising it is a",
        "program upgrade on purpose: a limit an admin key could lift quietly is not much of one."
      ],
      "type": "u64",
      "value": "1000"
    },
    {
      "name": "positionAuthoritySeed",
      "type": "bytes",
      "value": "[112, 111, 115, 105, 116, 105, 111, 110, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "positionSeed",
      "type": "bytes",
      "value": "[112, 111, 115, 105, 116, 105, 111, 110]"
    }
  ]
};
