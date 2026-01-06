local M = {}

local ok_snacks, Snacks = pcall(require, "snacks")

local function notify(message, level)
    vim.notify(message, level or vim.log.levels.INFO, { title = "Journal" })
end

local function ensure_snacks()
    if ok_snacks then
        return true
    end
    notify("snacks.nvim is not available.", vim.log.levels.ERROR)
    return false
end

local function confirm_with_zen(picker)
    Snacks.picker.actions.jump(picker, nil, { cmd = "edit" })
    vim.schedule(function()
        pcall(vim.cmd, "ZenMode")
    end)
end

local function run_j_async(args, on_success)
    local cmd = vim.fn.exepath("j")
    if cmd == "" then
        notify("j CLI not found in PATH.", vim.log.levels.ERROR)
        return
    end

    local cmd_list = { cmd }
    for _, arg in ipairs(args) do
        table.insert(cmd_list, arg)
    end

    local stderr = {}
    local job_id = vim.fn.jobstart(cmd_list, {
        stdout_buffered = true,
        stderr_buffered = true,
        on_stderr = function(_, data, _)
            if not data then
                return
            end
            for _, line in ipairs(data) do
                if line ~= "" then
                    table.insert(stderr, line)
                end
            end
        end,
        on_exit = function(_, code, _)
            if code ~= 0 then
                local message = #stderr > 0 and table.concat(stderr, "\n") or "j command failed."
                notify(message, vim.log.levels.ERROR)
                return
            end
            if on_success then
                vim.schedule(on_success)
            end
        end,
    })

    if job_id <= 0 then
        notify("Failed to start j command.", vim.log.levels.ERROR)
    end
end

local function run_j_json(args, on_success)
    local cmd = vim.fn.exepath("j")
    if cmd == "" then
        notify("j CLI not found in PATH.", vim.log.levels.ERROR)
        return
    end

    local cmd_list = { cmd }
    vim.list_extend(cmd_list, args)
    table.insert(cmd_list, "--json")

    local function handle_output(output, code, stderr)
        if code ~= 0 then
            local message = (stderr and stderr ~= "" and stderr) or (output and output ~= "" and output)
                or "j command failed."
            notify(message, vim.log.levels.ERROR)
            return
        end

        local ok, data = pcall(vim.json.decode, output or "")
        if not ok then
            notify("Failed to parse j --json output.", vim.log.levels.ERROR)
            return
        end

        if on_success then
            vim.schedule(function() on_success(data) end)
        end
    end

    if vim.system then
        vim.system(cmd_list, { text = true }, function(result)
            handle_output(result.stdout, result.code, result.stderr)
        end)
        return
    end

    local output = vim.fn.system(cmd_list)
    handle_output(output, vim.v.shell_error, "")
end

local function refresh_buffer(buf)
    if not vim.api.nvim_buf_is_valid(buf) then
        return
    end
    local view = vim.fn.winsaveview()
    vim.cmd("silent! checktime")
    vim.fn.winrestview(view)
end

local function open_note_in_editor(slug)
    if not slug or slug == "" then
        return
    end
    local home = vim.env.HOME or vim.fn.expand("~")
    local path = vim.fs.joinpath(home, "journal", "notes", slug .. ".md")
    vim.cmd("edit " .. vim.fn.fnameescape(path))
    vim.schedule(function()
        pcall(vim.cmd, "ZenMode")
    end)
end

local function select_note_slug(on_choice)
    if not ensure_snacks() then
        return
    end

    run_j_json({ "--note" }, function(payload)
        local notes = payload and payload.notes or {}

        Snacks.picker.pick({
            title = "Select Note",
            live = true,
            preview = "preview",
            format = "text",
            finder = function(_, ctx)
                local query = vim.trim(ctx.filter.search or "")
                local new_label = query ~= "" and ("new: " .. query) or "new: <type slug>"
                local items = {
                    {
                        text = new_label,
                        is_new = true,
                        slug = query,
                        preview = {
                            text = query ~= "" and ("Create new note: " .. query) or "Create new note",
                            ft = "markdown",
                            loc = false,
                        },
                    },
                }

                for _, note in ipairs(notes) do
                    if note.slug and note.path then
                        table.insert(items, {
                            text = note.slug,
                            slug = note.slug,
                            file = note.path,
                            preview = "file",
                        })
                    end
                end

                return items
            end,
            sort = function(a, b)
                if a.is_new ~= b.is_new then
                    return a.is_new
                end
                return (a.text or "") < (b.text or "")
            end,
            filter = {
                transform = function(_, filter)
                    filter.pattern = filter.search
                    return true
                end,
            },
            actions = {
                confirm = function(picker, item)
                    item = item or picker:selected({ fallback = true })[1]
                    if not item then
                        return
                    end

                    if item.is_new then
                        local slug = item.slug or ""
                        if slug == "" then
                            notify("Type a slug to create a new note.", vim.log.levels.WARN)
                            return
                        end
                        picker:close()
                        on_choice(slug)
                        return
                    end

                    picker:close()
                    if item.slug and item.slug ~= "" then
                        on_choice(item.slug)
                    end
                end,
            },
        })
    end)
end

local function extract_section()
    if not ensure_snacks() then
        return
    end

    local buf = vim.api.nvim_get_current_buf()
    local file = vim.api.nvim_buf_get_name(buf)
    if file == "" then
        notify("Buffer has no file path.", vim.log.levels.ERROR)
        return
    end

    if vim.bo[buf].modified then
        pcall(vim.cmd, "silent write")
    end

    run_j_json({ "--sections", file }, function(payload)
        local sections = payload and payload.sections or {}
        if not sections or #sections == 0 then
            notify("No sections found.", vim.log.levels.WARN)
            return
        end

        local items = {}
        for _, section in ipairs(sections) do
            local title = section.title or "(empty section)"
            local preview_text = section.preview or ""
            table.insert(items, {
                text = string.format("%02d %s", section.index or 0, title),
                preview = { text = preview_text, ft = "markdown" },
                section_index = section.index,
            })
        end

        Snacks.picker.pick({
            items = items,
            title = "Extract Section",
            preview = "preview",
            format = "text",
            actions = {
                confirm = function(picker)
                    local selected = picker:selected({ fallback = true })
                    if not selected or #selected == 0 then
                        return
                    end
                    local indices = {}
                    for _, item in ipairs(selected) do
                        if item.section_index then
                            table.insert(indices, item.section_index)
                        end
                    end
                    if #indices == 0 then
                        return
                    end
                    table.sort(indices)
                    picker:close()
                    select_note_slug(function(slug)
                        if not slug or slug == "" then
                            notify("Extract cancelled.", vim.log.levels.WARN)
                            return
                        end
                        run_j_async({
                            "--extract",
                            file,
                            "--sections=" .. table.concat(indices, ","),
                            "--slug",
                            slug,
                        }, function()
                            refresh_buffer(buf)
                            open_note_in_editor(slug)
                        end)
                    end)
                end,
            },
        })
    end)
end

local function open_entries(tag)
    if not ensure_snacks() then
        return
    end

    local args = tag and { "--tag=" .. tag } or { "--date" }
    run_j_json(args, function(payload)
        local entries = payload and payload.entries or {}
        if not entries or #entries == 0 then
            notify("No journal entries found.", vim.log.levels.WARN)
            return
        end

        local items = {}
        for _, entry in ipairs(entries) do
            if entry.path then
                local label = entry.date or vim.fn.fnamemodify(entry.path, ":t:r")
                table.insert(items, {
                    text = label,
                    file = entry.path,
                })
            end
        end

        Snacks.picker.pick({
            items = items,
            title = tag and ("Journal: " .. tag) or "Journal",
            preview = "file",
            format = "text",
            actions = {
                confirm = confirm_with_zen,
            },
        })
    end)
end

local function open_tags()
    if not ensure_snacks() then
        return
    end

    run_j_json({ "--tag" }, function(payload)
        local tags = payload and payload.tags or {}
        if not tags or #tags == 0 then
            notify("No tags found.", vim.log.levels.WARN)
            return
        end

        Snacks.picker.select(tags, { prompt = "Journal Tag" }, function(tag)
            if not tag or tag == "" then
                return
            end
            open_entries(tag)
        end)
    end)
end

local function open_search()
    if not ensure_snacks() then
        return
    end

    run_j_json({ "--search" }, function(payload)
        local matches = payload and payload.matches or {}
        if not matches or #matches == 0 then
            notify("No matches found.", vim.log.levels.WARN)
            return
        end

        local items = {}
        for _, match in ipairs(matches) do
            local line = tonumber(match.line)
            if match.path and line then
                local text = match.text or ""
                local label = string.format("%s:%d: %s", match.path, line, text)
                table.insert(items, {
                    text = label,
                    file = match.path,
                    pos = { line, 1 },
                })
            end
        end

        Snacks.picker.pick({
            items = items,
            title = "Journal Search",
            preview = "file",
            format = "text",
            actions = {
                confirm = confirm_with_zen,
            },
        })
    end)
end

function M.setup()
    vim.keymap.set({ "n", "v" }, "<leader>jx", extract_section, { desc = "Journal: Extract section", silent = true })
    vim.keymap.set("n", "<leader>jl", open_search, { desc = "Journal: Search", silent = true })
    vim.keymap.set("n", "<leader>jt", open_tags, { desc = "Journal: Tags", silent = true })
end

return M
