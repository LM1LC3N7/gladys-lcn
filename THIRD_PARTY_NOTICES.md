# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported code
was rewritten, not copied; the changes are described at the top of
`src/lcn/pck.js` and `src/lcn/client.js`.

## pypck

<https://github.com/alengwenus/pypck> (package `pypck`), by Andre Lengwenus
and its contributors, the library of the Home Assistant LCN integration.
Read at commit `01c95c9` of the main branch (version `0.9.15a3`, after the
release 0.9.14 of 2026-07-01).

Ported: the PCK syntax of LCN-PCHK (the login, the decimal and operation
modes, the keep-alive ping, the address headers, the status requests and
answers of the outputs, relays, binary sensors, variables, set points,
serial numbers and names, the keys sent to the host, the acknowledgements,
the scan of the segment couplers and of the modules, the commands of the
outputs, relays and scenes), the conversion of the variable values and the
names of the hardware types.

Its `LICENSE` file is the MIT License, without a copyright line;
`pyproject.toml` names the author, Andre Lengwenus. Its terms:

```
MIT License

pypck, by Andre Lengwenus (author named in pyproject.toml)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## The rate-limited publisher

`src/publisher.js` comes from LM1LC3N7/gladys-velbus, by the same author and
under the same licence as this integration (Apache-2.0).

LCN and LCN-PCHK are names of ISSENDORFF KG. This integration is not
affiliated with it.
