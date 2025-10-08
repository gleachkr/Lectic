vim.api.nvim_create_autocmd("FileType", {
    callback = function() vim.lsp.start({
        name = 'lectic',
        cmd = {'lectic', 'lsp'},
        root_dir = vim.fs.root(0, { ".git", "lectic.yaml" }) or vim.fn.getcwd(),
        single_file_support = true,
    }) end,
    pattern = { "lectic", "lectic.markdown", "markdown.lectic" }
})
