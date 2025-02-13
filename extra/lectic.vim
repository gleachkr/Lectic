sign define lecticHighlightBlock texthl=CursorLine linehl=CursorLine numhl=CursorLine

function! HighlightBlocks()
  let l:line_number = 1
  let l:in_block = 0

  while l:line_number <= line('$')
    let l:current_line = getline(l:line_number)

    if l:current_line =~ '^:::\s*\S\+.*$'
      let l:in_block = 1
    endif

    if l:in_block
      execute 'sign place ' . l:line_number . ' line=' . l:line_number . ' name=lecticHighlightBlock file=' . expand('%:p')
      if l:current_line =~ '^:::$'
        let l:in_block = 0
      endif
    endif

    let l:line_number += 1
  endwhile
endfunction

function! RemoveHighlightBlocks()
    sign unplace * group=lecticHighlightBlock
endfunction

" this function pipes the buffer through the exteral command 'lectic', calls
" HighlightBlocks() and places the cursor on the final line of the buffer
function! SubmitLectic()
    call RemoveHighlightBlocks()
    if executable('lectic')
        silent %!lectic
        call HighlightBlocks()
        normal! G
    else
        echo "Error: `lectic` binary is not found in the PATH."
    endif
endfunction

    
command! Lectic call SubmitLectic()
