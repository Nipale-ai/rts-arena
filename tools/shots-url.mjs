// The page address of the close-up tools (shots-buildings, shots-units-game): the capture page of a running spectate server, plus an optional theme and free query parts.
//   node tools/shots-buildings.mjs ... --theme dustmoon-v1        same as --q theme=dustmoon-v1; without --theme the address is exactly the old one
export function shotUrl(url, A = {}) {
  return url + '?capture=1' + (A.theme ? '&theme=' + encodeURIComponent(A.theme) : '') + (A.q ? '&' + A.q : '');
}
