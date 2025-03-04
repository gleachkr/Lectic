local parent_ft = "markdown"
if vim.filetype.match({ filename = "test.pandoc" }) == "pandoc" then
    parent_ft = "pandoc"
end

vim.filetype.add({
    extension = {
        lec = 'lectic.' .. parent_ft,
        lectic = 'lectic.' .. parent_ft
    }
})
